package com.personal.contentworkbench;
import org.junit.Test;
import static org.junit.Assert.*;

public class RequestPolicyTest {
    private final String origin = "https://workbench.example.com";
    private final RequestPolicy policy = new RequestPolicy(origin);
    @Test public void protectedGatewayUsesExistingRoutes() {
        assertTrue(policy.gateway(origin + "/host/api/auth/login", "POST"));
        assertTrue(policy.gateway(origin + "/host/api/jobs/job-1/cancel", "POST"));
        assertTrue(policy.gateway(origin + "/host/api/jobs?limit=100", "GET"));
        assertFalse(policy.gateway(origin + "/host/api/qwen/config", "POST"));
        assertFalse(policy.gateway(origin + "/host/api/auth/setup", "POST"));
        assertFalse(policy.gateway(origin + "/host/api/migrate", "POST"));
        assertFalse(policy.gateway(origin + "/host/api/browser/open", "POST"));
        assertFalse(policy.gateway(origin + "/host/api/state", "POST"));
        assertFalse(policy.gateway(origin + "/host/api/jobs?limit=101", "GET"));
        assertFalse(policy.gateway(origin + "/host/api/jobs?target=https://elsewhere", "GET"));
    }
    @Test public void rejectsOtherOriginsAndTraversal() {
        for (String url : new String[]{"http://workbench.example.com/", "https://workbench.example.com.evil/", "https://user@workbench.example.com/", origin + ":444/", "file:///data/private", "intent://app"}) assertFalse(policy.sameOrigin(url));
        for (String path : new String[]{"/../secret", "/%2e%2e/secret", "/foo//bar", "/host/api/state"}) assertFalse(policy.asset(origin + path));
        assertTrue(policy.asset(origin + "/assets/app-a.js"));
        assertTrue(policy.page(origin + "/"));
        assertFalse(policy.page(origin + "/host/api/state"));
    }
    @Test public void externalLinksDoNotAcceptScriptsOrCredentials() {
        assertTrue(policy.external("https://www.douyin.com/video/123"));
        assertFalse(policy.external("javascript:alert(1)"));
        assertFalse(policy.external("https://user:password@example.com/"));
        assertFalse(policy.external("http://example.com/"));
    }
    @Test public void streamingAndDiscoveryRoutesMatchTheWebsite() {
        String media = origin + "/host/api/previews/1234567890123456789/0123456789abcdef/media";
        assertTrue(policy.gateway(origin + "/host/api/previews/prepare", "POST"));
        assertTrue(policy.gateway(origin + "/host/api/previews/1234567890123456789/status", "GET"));
        assertTrue(policy.gateway(media, "GET"));
        assertTrue(policy.gateway(media, "HEAD"));
        assertTrue(policy.gateway(origin + "/host/api/discoveries/clear", "POST"));
        assertFalse(policy.gateway(media, "POST"));
        assertFalse(policy.gateway(media + "?url=https://elsewhere", "GET"));
        assertFalse(policy.gateway(origin + "/host/api/previews/invalid/0123456789abcdef/media", "GET"));
        assertFalse(policy.gateway(origin + "/host/api/previews/1234567890123456789/status", "HEAD"));
        assertFalse(policy.gateway(origin + "/host/api/previews/1234567890123456789/INVALID/media", "GET"));
    }
}
