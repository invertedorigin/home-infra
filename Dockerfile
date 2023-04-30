ARG IMAGE=node:12@sha256:6e5264cd4cfaefd7174b2bc10c7f9a1c2b99d98d127fc57a802d264da9fb43bd
FROM ${IMAGE}
 # renovate: datasource=github-tags depName=nodejs/node versioning=node
ENV NODE_VERSION=10.19.0
 # renovate: datasource=github-releases depName=composer/composer
ENV COMPOSER_VERSION=1.9.3
# renovate: datasource=docker depName=docker versioning=docker
ENV DOCKER_VERSION=19.03.15
# renovate: datasource=npm depName=yarn
ENV YARN_VERSION=1.19.1