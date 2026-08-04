FROM ubuntu:22.04 AS build

ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential \
    ca-certificates \
    cmake \
    git \
    libopencv-dev \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY . .

# Older doctest releases use SIGSTKSZ in a constant expression, which newer
# glibc versions reject. The repository pins that older release as a submodule.
RUN sed -i 's/SIGSTKSZ/8192/g' src/third_party/doctest/doctest/doctest.h

RUN cmake -S . -B build \
      -DCMAKE_BUILD_TYPE=Release \
      -DCMAKE_CXX_FLAGS="-Wno-error=sign-compare -Wno-error=stringop-overflow -Wno-error=unused-parameter" \
    && cmake --build build --parallel "$(nproc)"

FROM ubuntu:22.04
ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update && apt-get install -y --no-install-recommends \
    libopencv-dev \
    libtbb12 \
    && rm -rf /var/lib/apt/lists/*
COPY --from=build /app/build/buv /usr/local/bin/buv
ENTRYPOINT ["buv"]
