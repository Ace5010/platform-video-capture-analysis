package com.personal.contentworkbench;

import android.app.Activity;
import android.app.Instrumentation;
import android.content.Intent;
import android.os.Bundle;
import android.os.SystemClock;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import org.json.JSONArray;
import org.json.JSONObject;
import java.io.ByteArrayInputStream;
import java.nio.charset.StandardCharsets;
import java.util.Collections;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicReference;

/** Runs only from a separately installed instrumentation APK; no test hooks ship in the app. */
public final class WorkbenchInstrumentation extends Instrumentation {
    private WebView web;
    private WebViewClient nativeClient;
    private volatile WebResourceRequest failedPageRequest;
    private Activity activity;
    private Bundle arguments;
    private volatile JSONObject data;
    private volatile boolean outage;
    private volatile boolean pageOutage;
    private final AtomicInteger writes = new AtomicInteger();
    private final AtomicInteger checks = new AtomicInteger();
    private final java.util.List<String> diagnostics = new java.util.concurrent.CopyOnWriteArrayList<>();
    @Override public void onCreate(Bundle args) { super.onCreate(args); arguments = args; start(); }
    @Override public void onStart() {
        Bundle result = new Bundle();
        try {
            Intent intent = new Intent(getTargetContext(), MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            activity = startActivitySync(intent);
            runOnMainSync(() -> activity.getWindow().addFlags(android.view.WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON));
            java.lang.reflect.Field field = MainActivity.class.getDeclaredField("webView"); field.setAccessible(true); web = (WebView) field.get(activity);
            require(web != null, "WebView created");
            await("document.visibilityState==='visible'", 15000);
            runOnMainSync(() -> web.setWebChromeClient(new android.webkit.WebChromeClient() {
                @Override public boolean onConsoleMessage(android.webkit.ConsoleMessage message) {
                    if (message.messageLevel() == android.webkit.ConsoleMessage.MessageLevel.ERROR) diagnostics.add(message.message());
                    return true;
                }
            }));
            if ("live".equals(arguments.getString("mode"))) {
                runOnMainSync(() -> {
                    WebViewClient original = web.getWebViewClient();
                    web.setWebViewClient(new WebViewClient() {
                        @Override public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) { return original.shouldInterceptRequest(view, request); }
                        @Override public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) { return original.shouldOverrideUrlLoading(view, request); }
                        @Override public void onPageStarted(WebView view, String url, android.graphics.Bitmap favicon) { original.onPageStarted(view, url, favicon); }
                        @Override public void onPageCommitVisible(WebView view, String url) { original.onPageCommitVisible(view, url); }
                        @Override public void onPageFinished(WebView view, String url) { original.onPageFinished(view, url); }
                        @Override public void onReceivedHttpError(WebView view, WebResourceRequest request, WebResourceResponse response) {
                            if (request.isForMainFrame()) diagnostics.add("Main page HTTP " + response.getStatusCode());
                            original.onReceivedHttpError(view, request, response);
                        }
                        @Override public void onReceivedError(WebView view, WebResourceRequest request, android.webkit.WebResourceError error) {
                            if (request.isForMainFrame()) diagnostics.add("Main page " + error.getErrorCode() + " " + error.getDescription());
                            original.onReceivedError(view, request, error);
                        }
                    });
                });
                await("document.querySelector('input[type=password],.appShell')!==null", 35000);
                require("true".equals(js("location.origin==='" + BuildConfig.WORKBENCH_ORIGIN + "'")), "production origin");
                require("true".equals(js("document.title==='内容情报台'")), "remote website title");
                saveScreenshot("phone-live.png");
                result.putString("stream", "PASS: read-only remote website startup. Existing session=" + js("document.querySelector('.appShell')!==null") + "; styles=" + js("[...document.querySelectorAll('link[rel=stylesheet]')].map(e=>e.getAttribute('href')).join(',')") + "; no password entered or task submitted. Checks=" + checks.get());
            } else {
                try (java.io.InputStream input = getContext().getAssets().open("fixture.json")) { data = new JSONObject(new String(read(input), StandardCharsets.UTF_8)); }
                runOnMainSync(() -> {
                    WebViewClient original = web.getWebViewClient();
                    nativeClient = original;
                    web.setWebViewClient(new WebViewClient() {
                        @Override public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
                            WebResourceResponse response = original.shouldInterceptRequest(view, request);
                            if (response != null && response.getStatusCode() >= 400) diagnostics.add(request.getUrl().getPath() + " " + response.getStatusCode());
                            if (response != null) return response;
                            if (request.getUrl().getPath().startsWith("/host/")) return mock(request);
                            return websiteFixture(request);
                        }
                        @Override public void onPageStarted(WebView view, String url, android.graphics.Bitmap favicon) { original.onPageStarted(view, url, favicon); }
                        @Override public void onPageCommitVisible(WebView view, String url) { original.onPageCommitVisible(view, url); }
                        @Override public void onPageFinished(WebView view, String url) { original.onPageFinished(view, url); }
                        @Override public void onReceivedHttpError(WebView view, WebResourceRequest request, WebResourceResponse response) { original.onReceivedHttpError(view, request, response); }
                        @Override public void onReceivedError(WebView view, WebResourceRequest request, android.webkit.WebResourceError error) { original.onReceivedError(view, request, error); }
                    });
                    web.reload();
                });
                await("document.querySelectorAll('.compactVideo').length===9", 25000);
                require("true".equals(js("document.documentElement.scrollWidth<=document.documentElement.clientWidth")), "phone has no horizontal overflow");
                require("true".equals(js("getComputedStyle(document.querySelector('.navigation')).position==='fixed'")), "bottom navigation");
                require("true".equals(js("getComputedStyle(document.querySelector('.compactVideoSummary')).display!=='none'")), "same content summaries as desktop");
                require("true".equals(js("!document.body.textContent.includes('采集和分析由电脑执行')&&!document.body.textContent.includes('主机地址：')")), "no implementation notes in phone interface");
                require("true".equals(js("document.querySelector('.compactVideo').getBoundingClientRect().top<innerHeight*.42")), "phone content begins in upper half");
                saveScreenshot("phone-feed.png");
                js("document.querySelector('.compactVideoCopy').click()");
                await("document.querySelector('.contentBrowser').dataset.reading==='true'", 5000);
                saveScreenshot("phone-detail.png");
                require("true".equals(js("document.querySelector('.previewReading').getBoundingClientRect().top<document.querySelector('.previewVideoMetrics').getBoundingClientRect().top")), "summary before metrics");
                if ("layout".equals(arguments.getString("mode"))) {
                    js("[...document.querySelectorAll('.previewActions button')].find(b=>b.textContent.includes('展开完整结果')).click()");
                    await("document.querySelector('.readingDialog[open]')!==null", 5000);
                    require("true".equals(js("(()=>{const tabs=[...document.querySelectorAll('.readerTabs button')];return tabs.length===3&&Math.max(...tabs.map(e=>e.getBoundingClientRect().top))-Math.min(...tabs.map(e=>e.getBoundingClientRect().top))<1;})()")), "reader tabs share one row");
                    require("true".equals(js("document.querySelector('.readerBody').getBoundingClientRect().top<innerHeight*.7")), "reader text visible on first screen");
                    saveScreenshot("phone-reader.png");
                    js("(()=>{const s=document.querySelector('.readingFontControl select');s.value='22';s.dispatchEvent(new Event('change',{bubbles:true}));})()");
                    await("getComputedStyle(document.querySelector('.readerBody')).fontSize==='22px'", 5000);
                    js("document.querySelector('#reader-tab-transcript').click()");
                    await("document.querySelector('#reader-tab-transcript').getAttribute('aria-selected')==='true'", 5000);
                    runOnMainSync(() -> activity.onBackPressed());
                    await("document.querySelector('.readingDialog')===null", 5000);
                    result.putString("stream", "PASS: native phone reader layout, single-row tabs, readable first screen, font selection, section switching and back. Synthetic website/APIs only. Checks=" + checks.get());
                    runOnMainSync(() -> activity.finish());
                    finish(Activity.RESULT_OK, result);
                    return;
                }
                runOnMainSync(() -> activity.onBackPressed());
                await("document.querySelector('.contentBrowser').dataset.reading==='false'", 5000);
                js("document.querySelectorAll('.compactVideoCopy')[1].click()");
                await("document.querySelector('.previewActions .primaryButton').textContent.includes('分析此视频')", 5000);
                js("document.querySelector('.previewActions .primaryButton').click()");
                long deadline = SystemClock.elapsedRealtime() + 5000;
                while (writes.get() == 0 && SystemClock.elapsedRealtime() < deadline) SystemClock.sleep(50);
                require(writes.get() == 1, "one analysis request submitted to shared queue");
                runOnMainSync(() -> activity.onBackPressed());
                await("document.querySelector('.contentBrowser').dataset.reading==='false'", 5000);
                JSONObject updated = new JSONObject(data.toString());
                JSONArray rows = updated.getJSONArray("videos");
                for (int i=0;i<rows.length();i++) if (rows.getJSONObject(i).getString("id").endsWith("0007")) rows.getJSONObject(i).put("likeCount", 9876);
                data = updated;
                await("document.querySelector('.mobileVideoMetrics').textContent.includes('9,876')", 8000);
                outage = true;
                await("document.body.textContent.includes('未连接')||document.body.textContent.includes('暂时')", 8000);
                require("true".equals(js("document.querySelectorAll('.compactVideo').length===9")), "disconnect retains existing results");
                outage = false;
                js("window.dispatchEvent(new Event('focus'))");
                await("document.querySelector('[title=主机已连接]')!==null||document.body.textContent.includes('主机已连接')", 8000);
                require(writes.get() == 1, "reconnect does not resend paid task");
                js("[...document.querySelectorAll('.navigation button')].find(b=>b.textContent.includes('互动数据')).click()");
                await("document.querySelector('.mobileMetricSort')!==null", 5000);
                require("true".equals(js("window.scrollY===0")), "destination opens at top");
                js("(()=>{const s=document.querySelector('.mobileMetricSort');s.value='value';s.dispatchEvent(new Event('change',{bubbles:true}));})()");
                await("document.querySelector('.metricSort .active').textContent.includes('高低')", 5000);
                require("true".equals(js("document.querySelector('.metricBarGroup').getAttribute('aria-label').includes('9,876')")), "ranking uses selected metric");
                js("[...document.querySelectorAll('.metricChartModes button')].find(b=>b.textContent.includes('柱')).click()");
                await("document.querySelector('.metricValueBar')!==null", 5000);
                require("true".equals(js("document.querySelector('.metricBarChartScroll').scrollWidth<=document.querySelector('.metricBarChartScroll').clientWidth+1")), "all bars fit phone width");
                saveScreenshot("phone-analytics.png");
                js("[...document.querySelectorAll('.navigation button')].find(b=>b.textContent.includes('链接分析')).click()");
                await("document.querySelector('.linkAnalysisEntry textarea')!==null", 5000);
                saveScreenshot("phone-links.png");
                js("[...document.querySelectorAll('.navigation button')].find(b=>b.textContent.includes('信源管理')).click()");
                await("document.querySelector('.accountCard')!==null", 5000);
                require("true".equals(js("!document.querySelector('.accountTop .accountFollowers')")), "followers displayed once per account");
                saveScreenshot("phone-accounts.png");
                js("document.querySelector('.serviceStatus>summary').click()");
                await("document.querySelector('.serviceStatus').open", 5000);
                saveScreenshot("phone-settings.png");
                runOnMainSync(() -> activity.onBackPressed());
                await("!document.querySelector('.serviceStatus').open", 5000);
                pageOutage = true;
                runOnMainSync(() -> web.reload());
                await("document.body.textContent==='{}'", 5000);
                // Chromium does not dispatch HTTP-error callbacks for a response
                // synthesized by shouldInterceptRequest. Exercise the native
                // callback explicitly, then retry through the real page loader.
                require(failedPageRequest != null, "synthetic main-page failure was intercepted");
                runOnMainSync(() -> nativeClient.onReceivedHttpError(web, failedPageRequest, json(503, new JSONObject())));
                java.lang.reflect.Field retry = MainActivity.class.getDeclaredField("retryButton"); retry.setAccessible(true);
                android.widget.Button retryButton = (android.widget.Button) retry.get(activity);
                AtomicInteger retryVisibility = new AtomicInteger();
                runOnMainSync(() -> retryVisibility.set(retryButton.getVisibility()));
                require(retryVisibility.get() == android.view.View.VISIBLE, "website failure offers native retry");
                pageOutage = false;
                runOnMainSync(() -> retryButton.performClick());
                await("document.querySelectorAll('.compactVideo').length===9", 25000);
                require(writes.get() == 1, "website retry never resends analysis");
                result.putString("stream", "PASS: remote-loading shell, desktop summaries, back, analysis queue, incoming update, outage/recovery, no resend, metric sorting, website failure/retry. Synthetic website/APIs only. Checks=" + checks.get());
            }
            runOnMainSync(() -> activity.finish());
            finish(Activity.RESULT_OK, result);
        } catch (Throwable error) {
            result.putString("stream", "FAIL: " + error.getClass().getSimpleName() + ": " + error.getMessage());
            try { result.putString("stream", result.getString("stream") + "\nUI: " + js("JSON.stringify({title:document.title,text:document.body.innerText.slice(0,700),ready:document.readyState,href:location.href})")); } catch (Exception ignored) { }
            result.putString("stream", result.getString("stream") + "\nErrors: " + diagnostics);
            finish(Activity.RESULT_CANCELED, result);
        }
    }
    private void saveScreenshot(String name) throws Exception {
        CountDownLatch drawn = new CountDownLatch(1);
        runOnMainSync(() -> web.postVisualStateCallback(0, new WebView.VisualStateCallback() {
            @Override public void onComplete(long requestId) { drawn.countDown(); }
        }));
        if (!drawn.await(5, TimeUnit.SECONDS)) throw new AssertionError("WebView did not draw the requested page");
        waitForIdleSync();
        SystemClock.sleep(400);
        android.graphics.Bitmap bitmap = getUiAutomation().takeScreenshot();
        if (bitmap == null) throw new AssertionError("Unable to capture native display");
        java.io.File directory = getTargetContext().getExternalFilesDir(null);
        if (directory == null) throw new AssertionError("Native screenshot directory is unavailable");
        try (java.io.FileOutputStream output = new java.io.FileOutputStream(new java.io.File(directory, "mobile-qa-" + name))) {
            bitmap.compress(android.graphics.Bitmap.CompressFormat.PNG, 100, output);
        } finally { bitmap.recycle(); }
    }
    private WebResourceResponse websiteFixture(WebResourceRequest request) {
        String requested = request.getUrl().getPath();
        if (pageOutage && request.isForMainFrame()) { failedPageRequest = request; return json(503, new JSONObject()); }
        String file = requested.equals("/") ? "index.html" : requested.substring(1);
        String mime = file.endsWith(".html") ? "text/html" : file.endsWith(".css") ? "text/css"
            : file.endsWith(".js") || file.endsWith(".mjs") ? "application/javascript" : file.endsWith(".svg") ? "image/svg+xml" : "application/octet-stream";
        try {
            return new WebResourceResponse(mime, "UTF-8", 200, "OK", Collections.singletonMap("Cache-Control", "no-store"), getContext().getAssets().open("web/" + file));
        } catch (Exception error) { return json(404, new JSONObject()); }
    }
    private WebResourceResponse mock(WebResourceRequest request) {
        try {
            String path = request.getUrl().getPath().substring(5);
            if (outage) return json(503, new JSONObject().put("error", "模拟电脑暂时断连"));
            if (path.equals("/api/auth/status")) return json(200, new JSONObject().put("authenticated", true).put("configured", true).put("isLocal", false).put("csrfToken", "synthetic-only"));
            if (path.equals("/api/state")) return json(200, new JSONObject().put("state", data));
            if (path.equals("/api/qwen/status")) return json(200, new JSONObject().put("configured", true));
            if (path.equals("/api/jobs") && request.getMethod().equals("POST")) {
                writes.incrementAndGet();
                return json(200, new JSONObject().put("job", new JSONObject().put("id", "synthetic-job").put("type", "analyze_video").put("status", "queued").put("payload", new JSONObject()).put("attemptCount", 0)));
            }
            if (path.equals("/api/jobs")) return json(200, new JSONObject().put("jobs", new JSONArray()));
            if (path.equals("/api/accounts/ack-updates") && request.getMethod().equals("POST")) return json(200, new JSONObject().put("ok", true));
            if (path.startsWith("/api/previews/")) return json(503, new JSONObject().put("error", "隔离测试未连接视频源"));
            return json(403, new JSONObject().put("error", "测试未授权此操作"));
        } catch (Exception error) { throw new RuntimeException(error); }
    }
    private WebResourceResponse json(int status, JSONObject value) {
        return new WebResourceResponse("application/json", "UTF-8", status, status == 200 ? "OK" : "Unavailable", Collections.singletonMap("Cache-Control", "no-store"), new ByteArrayInputStream(value.toString().getBytes(StandardCharsets.UTF_8)));
    }
    private String js(String code) throws Exception {
        CountDownLatch latch = new CountDownLatch(1); AtomicReference<String> result = new AtomicReference<>();
        runOnMainSync(() -> web.evaluateJavascript(code, value -> { result.set(value); latch.countDown(); }));
        if (!latch.await(5, TimeUnit.SECONDS)) throw new AssertionError("JavaScript response timed out");
        return result.get();
    }
    private void await(String expression, long timeout) throws Exception {
        long deadline = SystemClock.elapsedRealtime() + timeout;
        while (SystemClock.elapsedRealtime() < deadline) { if ("true".equals(js(expression))) { checks.incrementAndGet(); return; } SystemClock.sleep(100); }
        throw new AssertionError("Timed out: " + expression);
    }
    private void require(boolean passed, String description) { if (!passed) throw new AssertionError(description); checks.incrementAndGet(); }
    private byte[] read(java.io.InputStream input) throws Exception { java.io.ByteArrayOutputStream out = new java.io.ByteArrayOutputStream(); byte[] buffer = new byte[8192]; int n; while ((n=input.read(buffer))!=-1) out.write(buffer,0,n); return out.toByteArray(); }
}
