package com.personal.contentworkbench;

import java.net.URI;
import java.util.Set;
import java.util.HashSet;
import java.util.Arrays;

/** Same-origin assets + existing authenticated HTTPS gateway. No credential bridge. */
public final class RequestPolicy {
    private static final Set<String> GET = new HashSet<>(Arrays.asList("/health", "/api/auth/status", "/api/state", "/api/jobs", "/api/qwen", "/api/qwen/status"));
    private static final Set<String> POST = new HashSet<>(Arrays.asList("/api/auth/login", "/api/auth/logout", "/api/accounts/upsert", "/api/accounts/remove", "/api/accounts/ack-updates", "/api/discoveries/clear", "/api/video-links/analyze", "/api/jobs", "/api/previews/prepare"));
    private final String origin;
    public RequestPolicy(String origin) { this.origin = origin; }
    public boolean sameOrigin(String url) {
        try {
            URI uri = URI.create(url);
            return "https".equals(uri.getScheme()) && uri.getRawUserInfo() == null && uri.getPort() == -1
                && origin.equals("https://" + uri.getHost());
        } catch (RuntimeException ignored) { return false; }
    }
    public boolean gateway(String url, String method) {
        if (!sameOrigin(url)) return false;
        URI uri = URI.create(url);
        String path = uri.getRawPath();
        if (!path.startsWith("/host/")) return false;
        path = path.substring(5);
        boolean media = path.matches("/api/previews/[0-9]{1,32}/[a-f0-9]{8,64}/media");
        boolean allowed = "GET".equals(method) ? GET.contains(path) || media || path.matches("/api/previews/[0-9]{1,32}/status") || path.matches("/api/jobs/[a-zA-Z0-9_-]+")
            : "HEAD".equals(method) ? media
            : "POST".equals(method) && (POST.contains(path) || path.matches("/api/jobs/[a-zA-Z0-9_-]+/cancel"));
        String query = uri.getRawQuery();
        return allowed && (query == null || ("GET".equals(method) && path.equals("/api/jobs") && query.matches("limit=([1-9][0-9]?|100)")));
    }
    public boolean asset(String url) {
        if (!sameOrigin(url)) return false;
        String raw = URI.create(url).getRawPath();
        if (raw == null || raw.contains("%") || raw.contains("\\") || raw.contains("//")) return false;
        for (String segment : raw.split("/")) if (segment.equals("..") || segment.equals(".")) return false;
        return !raw.startsWith("/host/");
    }
    public boolean page(String url) {
        if (!asset(url)) return false;
        String path = URI.create(url).getPath();
        return path.equals("/") || path.equals("/index.html");
    }
    public boolean external(String url) {
        try {
            URI uri = URI.create(url);
            return "https".equals(uri.getScheme()) && uri.getHost() != null && uri.getRawUserInfo() == null;
        } catch (RuntimeException ignored) { return false; }
    }
}
