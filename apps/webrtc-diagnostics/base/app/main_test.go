package main

import (
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/pion/webrtc/v4"
)

func TestFilterBrowserICEServers(t *testing.T) {
	servers := filterBrowserICEServers([]iceServer{
		{URLs: stringList{"stun:stun.cloudflare.com:3478", "stun:stun.cloudflare.com:53"}},
		{
			URLs:     stringList{"turn:turn.cloudflare.com:53?transport=udp", "turns:turn.cloudflare.com:443?transport=tcp"},
			Username: "u", Credential: "c",
		},
	})
	if len(servers) != 2 || len(servers[0].URLs) != 1 || len(servers[1].URLs) != 1 {
		t.Fatalf("unexpected filtered ICE servers: %#v", servers)
	}
}

func TestICEProviderCachesCredentials(t *testing.T) {
	calls := 0
	cloudflare := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		calls++
		_ = json.NewEncoder(w).Encode(map[string]any{
			"iceServers": []iceServer{{
				URLs:     stringList{"turns:turn.cloudflare.com:443?transport=tcp"},
				Username: "u", Credential: "c",
			}},
		})
	}))
	defer cloudflare.Close()
	provider := newICEProvider("key", "token", 900, cloudflare.Client())
	provider.client.Transport = roundTripperFunc(func(r *http.Request) (*http.Response, error) {
		r.URL.Scheme, r.URL.Host = "http", cloudflare.Listener.Addr().String()
		return http.DefaultTransport.RoundTrip(r)
	})
	one, two := provider.get(t.Context()), provider.get(t.Context())
	if calls != 1 || !one.TURNConfigured || !two.TURNConfigured {
		t.Fatalf("cache failure: calls=%d one=%#v two=%#v", calls, one, two)
	}
}

type roundTripperFunc func(*http.Request) (*http.Response, error)

func (f roundTripperFunc) RoundTrip(r *http.Request) (*http.Response, error) {
	return f(r)
}

func TestAppUsesNarrowICEPortRange(t *testing.T) {
	application, err := newApp(newICEProvider("", "", 900, nil), "public")
	if err != nil {
		t.Fatal(err)
	}
	application.close()
	if iceUDPMin != 50000 || iceUDPMax != 50099 {
		t.Fatalf("unexpected range %d-%d", iceUDPMin, iceUDPMax)
	}
}

func TestHTTPSignalingEstablishesEchoDataChannel(t *testing.T) {
	oldSTUN := defaultSTUN
	defaultSTUN = nil
	defer func() { defaultSTUN = oldSTUN }()

	application, err := newApp(newICEProvider("", "", 900, nil), "public")
	if err != nil {
		t.Fatal(err)
	}
	defer application.close()
	server := httptest.NewServer(application.handler())
	defer server.Close()

	pc, err := webrtc.NewPeerConnection(webrtc.Configuration{})
	if err != nil {
		t.Fatal(err)
	}
	defer pc.Close()
	channel, err := pc.CreateDataChannel("path-diagnostic", nil)
	if err != nil {
		t.Fatal(err)
	}
	opened := make(chan struct{})
	echoed := make(chan string, 1)
	channel.OnOpen(func() { close(opened) })
	channel.OnMessage(func(message webrtc.DataChannelMessage) { echoed <- string(message.Data) })

	offer, err := pc.CreateOffer(nil)
	if err != nil {
		t.Fatal(err)
	}
	gatherComplete := webrtc.GatheringCompletePromise(pc)
	if err := pc.SetLocalDescription(offer); err != nil {
		t.Fatal(err)
	}
	<-gatherComplete
	payload, err := json.Marshal(map[string]any{"offer": pc.LocalDescription()})
	if err != nil {
		t.Fatal(err)
	}
	response, err := http.Post(server.URL+"/api/offer", "application/json", bytes.NewReader(payload))
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusCreated {
		body, _ := io.ReadAll(response.Body)
		t.Fatalf("offer returned HTTP %d: %s", response.StatusCode, body)
	}
	var answer struct {
		Answer webrtc.SessionDescription `json:"answer"`
	}
	if err := json.NewDecoder(response.Body).Decode(&answer); err != nil {
		t.Fatal(err)
	}
	if err := pc.SetRemoteDescription(answer.Answer); err != nil {
		t.Fatal(err)
	}
	select {
	case <-opened:
	case <-time.After(8 * time.Second):
		t.Fatal("data channel did not open")
	}
	if err := channel.SendText("hello"); err != nil {
		t.Fatal(err)
	}
	select {
	case value := <-echoed:
		if value != "hello" {
			t.Fatalf("unexpected echo %q", value)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("echo did not return")
	}
}
