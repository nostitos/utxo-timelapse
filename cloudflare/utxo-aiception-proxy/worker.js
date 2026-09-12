export default {
  async fetch(request) {
    const url = new URL(request.url);
    url.hostname = "utxo-cdn.hat39.com";
    url.protocol = "https:";
    url.port = "";
    const upstream = new Request(url, request);
    upstream.headers.delete("cookie");
    upstream.headers.delete("authorization");
    return fetch(upstream);
  }
};
