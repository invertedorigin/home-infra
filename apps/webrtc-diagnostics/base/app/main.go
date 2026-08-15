package main

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/pion/webrtc/v4"
)

const (
	maxBodyBytes   = 1 << 20
	sessionTTL     = 60 * time.Second
	defaultTURNTTL = 900
	iceUDPMin      = 50000
	iceUDPMax      = 50099
)

var defaultSTUN = []iceServer{{URLs: stringList{"stun:stun.cloudflare.com:3478"}}}

type stringList []string

func (s *stringList) UnmarshalJSON(data []byte) error {
	var list []string
	if err := json.Unmarshal(data, &list); err == nil {
		*s = list
		return nil
	}
	var one string
	if err := json.Unmarshal(data, &one); err != nil {
		return errors.New("ICE server urls must be a string or array")
	}
	*s = []string{one}
	return nil
}

type iceServer struct {
	URLs       stringList `json:"urls"`
	Username   string     `json:"username,omitempty"`
	Credential string     `json:"credential,omitempty"`
}

type iceConfig struct {
	ICEServers     []iceServer `json:"iceServers"`
	TURNConfigured bool        `json:"turnConfigured"`
	ExpiresAt      *int64      `json:"expiresAt"`
	Warning        string      `json:"warning,omitempty"`
}

type iceProvider struct {
	keyID, apiToken string
	ttl             int
	client          *http.Client
	mu              sync.Mutex
	cached          iceConfig
	expiresAt       time.Time
}

func newICEProvider(keyID, apiToken string, ttl int, client *http.Client) *iceProvider {
	if ttl < 60 {
		ttl = defaultTURNTTL
	}
	if client == nil {
		client = &http.Client{Timeout: 10 * time.Second}
	}
	return &iceProvider{keyID: keyID, apiToken: apiToken, ttl: ttl, client: client}
}

func (p *iceProvider) get(ctx context.Context) iceConfig {
	if p.keyID == "" || p.apiToken == "" {
		return iceConfig{ICEServers: defaultSTUN}
	}
	p.mu.Lock()
	defer p.mu.Unlock()
	if !p.expiresAt.IsZero() && time.Until(p.expiresAt) > time.Duration(p.ttl)*time.Second/4 {
		return p.cached
	}
	config, err := p.mint(ctx)
	if err != nil {
		log.Printf("[ice] %v", err)
		if time.Now().Before(p.expiresAt) {
			return p.cached
		}
		return iceConfig{ICEServers: defaultSTUN, Warning: err.Error()}
	}
	p.cached, p.expiresAt = config, time.UnixMilli(*config.ExpiresAt)
	return config
}

func (p *iceProvider) mint(ctx context.Context) (iceConfig, error) {
	endpoint := fmt.Sprintf("https://rtc.live.cloudflare.com/v1/turn/keys/%s/credentials/generate-ice-servers", url.PathEscape(p.keyID))
	body := strings.NewReader(fmt.Sprintf(`{"ttl":%d}`, p.ttl))
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, body)
	if err != nil {
		return iceConfig{}, err
	}
	req.Header.Set("Authorization", "Bearer "+p.apiToken)
	req.Header.Set("Content-Type", "application/json")
	response, err := p.client.Do(req)
	if err != nil {
		return iceConfig{}, fmt.Errorf("Cloudflare TURN credential request failed: %w", err)
	}
	defer response.Body.Close()
	if response.StatusCode < 200 || response.StatusCode > 299 {
		_, _ = io.Copy(io.Discard, response.Body)
		return iceConfig{}, fmt.Errorf("Cloudflare TURN credential request returned HTTP %d", response.StatusCode)
	}
	var payload struct {
		ICEServers []iceServer `json:"iceServers"`
	}
	if err := json.NewDecoder(response.Body).Decode(&payload); err != nil {
		return iceConfig{}, fmt.Errorf("decode Cloudflare TURN response: %w", err)
	}
	urlCount := 0
	for _, server := range payload.ICEServers {
		urlCount += len(server.URLs)
	}
	if urlCount == 0 {
		return iceConfig{}, errors.New("Cloudflare TURN credential response contained no usable ICE servers")
	}
	expires := time.Now().Add(time.Duration(p.ttl) * time.Second).UnixMilli()
	log.Printf("[ice] minted Cloudflare TURN credentials with %ds TTL and %d ICE URLs", p.ttl, urlCount)
	return iceConfig{ICEServers: payload.ICEServers, TURNConfigured: true, ExpiresAt: &expires}, nil
}

func toPionServers(servers []iceServer) []webrtc.ICEServer {
	result := make([]webrtc.ICEServer, 0, len(servers))
	for _, server := range servers {
		result = append(result, webrtc.ICEServer{
			URLs: []string(server.URLs), Username: server.Username, Credential: server.Credential,
		})
	}
	return result
}

type session struct {
	pc    *webrtc.PeerConnection
	timer *time.Timer
}

type app struct {
	provider  *iceProvider
	api       *webrtc.API
	publicDir string
	sessions  map[string]*session
	mu        sync.Mutex
}

func newApp(provider *iceProvider, publicDir string) (*app, error) {
	engine := webrtc.SettingEngine{}
	if err := engine.SetEphemeralUDPPortRange(iceUDPMin, iceUDPMax); err != nil {
		return nil, fmt.Errorf("configure ICE UDP port range: %w", err)
	}
	return &app{
		provider:  provider,
		api:       webrtc.NewAPI(webrtc.WithSettingEngine(engine)),
		publicDir: publicDir,
		sessions:  map[string]*session{},
	}, nil
}

func (a *app) closeSession(id string) {
	a.mu.Lock()
	s := a.sessions[id]
	delete(a.sessions, id)
	a.mu.Unlock()
	if s != nil {
		s.timer.Stop()
		_ = s.pc.Close()
	}
}

func (a *app) close() {
	a.mu.Lock()
	ids := make([]string, 0, len(a.sessions))
	for id := range a.sessions {
		ids = append(ids, id)
	}
	a.mu.Unlock()
	for _, id := range ids {
		a.closeSession(id)
	}
}

func randomID() (string, error) {
	value := make([]byte, 16)
	if _, err := rand.Read(value); err != nil {
		return "", err
	}
	return hex.EncodeToString(value), nil
}

func writeJSON(w http.ResponseWriter, status int, value any) {
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(value)
}

func (a *app) handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
	})
	mux.HandleFunc("GET /api/config", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, http.StatusOK, a.provider.get(r.Context()))
	})
	mux.HandleFunc("POST /api/offer", a.offer)
	mux.HandleFunc("DELETE /api/session/{id}", func(w http.ResponseWriter, r *http.Request) {
		a.closeSession(r.PathValue("id"))
		w.WriteHeader(http.StatusNoContent)
	})
	mux.Handle("GET /", http.FileServer(http.Dir(a.publicDir)))
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Cache-Control", "no-store")
		w.Header().Set("Content-Security-Policy", "default-src 'self'; connect-src 'self'; img-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'")
		w.Header().Set("Cross-Origin-Opener-Policy", "same-origin")
		w.Header().Set("Referrer-Policy", "no-referrer")
		w.Header().Set("X-Content-Type-Options", "nosniff")
		w.Header().Set("X-Frame-Options", "DENY")
		mux.ServeHTTP(w, r)
	})
}

func (a *app) offer(w http.ResponseWriter, r *http.Request) {
	defer r.Body.Close()
	var request struct {
		Offer webrtc.SessionDescription `json:"offer"`
	}
	decoder := json.NewDecoder(http.MaxBytesReader(w, r.Body, maxBodyBytes))
	if err := decoder.Decode(&request); err != nil || request.Offer.Type != webrtc.SDPTypeOffer || request.Offer.SDP == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "offer must contain a WebRTC offer SDP"})
		return
	}
	config := a.provider.get(r.Context())
	pc, err := a.api.NewPeerConnection(webrtc.Configuration{ICEServers: toPionServers(config.ICEServers)})
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "could not create WebRTC peer"})
		return
	}
	succeeded := false
	defer func() {
		if !succeeded {
			_ = pc.Close()
		}
	}()
	candidates := make([]webrtc.ICECandidateInit, 0)
	var candidateMu sync.Mutex
	pc.OnICECandidate(func(candidate *webrtc.ICECandidate) {
		if candidate != nil {
			candidateMu.Lock()
			candidates = append(candidates, candidate.ToJSON())
			candidateMu.Unlock()
		}
	})
	pc.OnDataChannel(func(channel *webrtc.DataChannel) {
		channel.OnMessage(func(message webrtc.DataChannelMessage) {
			if message.IsString {
				_ = channel.SendText(string(message.Data))
			} else {
				_ = channel.Send(message.Data)
			}
		})
	})
	if err = pc.SetRemoteDescription(request.Offer); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid WebRTC offer"})
		return
	}
	answer, err := pc.CreateAnswer(nil)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "could not create WebRTC answer"})
		return
	}
	gatherComplete := webrtc.GatheringCompletePromise(pc)
	if err = pc.SetLocalDescription(answer); err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "could not set WebRTC answer"})
		return
	}
	select {
	case <-gatherComplete:
	case <-time.After(20 * time.Second):
	}
	id, err := randomID()
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "could not create session"})
		return
	}
	s := &session{pc: pc}
	s.timer = time.AfterFunc(sessionTTL, func() { a.closeSession(id) })
	a.mu.Lock()
	a.sessions[id] = s
	a.mu.Unlock()
	pc.OnConnectionStateChange(func(state webrtc.PeerConnectionState) {
		if state == webrtc.PeerConnectionStateFailed || state == webrtc.PeerConnectionStateClosed {
			go a.closeSession(id)
		}
	})
	candidateMu.Lock()
	gathered := append([]webrtc.ICECandidateInit(nil), candidates...)
	candidateMu.Unlock()
	succeeded = true
	writeJSON(w, http.StatusCreated, map[string]any{
		"answer": pc.LocalDescription(), "serverCandidates": gathered,
		"sessionId": id, "turnConfigured": config.TURNConfigured,
	})
}

func envInt(name string, fallback int) int {
	value, err := strconv.Atoi(os.Getenv(name))
	if err != nil {
		return fallback
	}
	return value
}

func main() {
	publicDir := os.Getenv("PUBLIC_DIR")
	if publicDir == "" {
		publicDir = filepath.Join(".", "public")
	}
	provider := newICEProvider(
		os.Getenv("ANYTONE_CF_TURN_KEY_ID"),
		os.Getenv("ANYTONE_CF_TURN_API_TOKEN"),
		envInt("ANYTONE_CF_TURN_TTL", defaultTURNTTL),
		nil,
	)
	application, err := newApp(provider, publicDir)
	if err != nil {
		log.Fatal(err)
	}
	defer application.close()
	address := os.Getenv("LISTEN_ADDRESS")
	if address == "" {
		address = ":8080"
	}
	server := &http.Server{
		Addr: address, Handler: application.handler(),
		ReadHeaderTimeout: 5 * time.Second, IdleTimeout: 60 * time.Second,
	}
	log.Printf("WebRTC diagnostics listening on %s; ICE UDP ports %d-%d", address, iceUDPMin, iceUDPMax)
	if err := server.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
		log.Fatal(err)
	}
}
