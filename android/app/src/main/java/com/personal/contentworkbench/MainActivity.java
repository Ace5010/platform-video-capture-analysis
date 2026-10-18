package com.personal.contentworkbench;

import android.annotation.SuppressLint;
import android.app.Activity;
import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.graphics.Color;
import android.graphics.Bitmap;
import android.net.Uri;
import android.net.http.SslError;
import android.os.Build;
import android.os.Bundle;
import android.os.Message;
import android.os.SystemClock;
import android.view.WindowInsets;
import android.view.WindowInsetsController;
import android.view.Gravity;
import android.view.View;
import android.webkit.CookieManager;
import android.webkit.JsResult;
import android.webkit.SslErrorHandler;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceError;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.FrameLayout;
import android.widget.TextView;
import android.widget.Button;
import android.widget.LinearLayout;
import android.widget.ProgressBar;
import android.widget.Toast;
import android.window.OnBackInvokedDispatcher;
import java.io.ByteArrayInputStream;
import java.util.Collections;

public final class MainActivity extends Activity {
    private WebView webView;
    private LinearLayout loadPanel;
    private TextView loadMessage;
    private ProgressBar loadProgress;
    private Button retryButton;
    private boolean pageFailed;
    private View fullScreen;
    private WebChromeClient.CustomViewCallback fullScreenCallback;
    private long backAt;
    private final RequestPolicy policy = new RequestPolicy(BuildConfig.WORKBENCH_ORIGIN);

    @SuppressLint("SetJavaScriptEnabled")
    @Override protected void onCreate(Bundle state) {
        super.onCreate(state);
        FrameLayout container = new FrameLayout(this);
        container.setBackgroundColor(Color.rgb(237, 247, 243));
        setContentView(container);
        if (Build.VERSION.SDK_INT >= 30) {
            getWindow().setDecorFitsSystemWindows(false);
            container.setOnApplyWindowInsetsListener((view, insets) -> {
                android.graphics.Insets bars = insets.getInsets(WindowInsets.Type.systemBars() | WindowInsets.Type.displayCutout());
                android.graphics.Insets ime = insets.getInsets(WindowInsets.Type.ime());
                view.setPadding(bars.left, bars.top, bars.right, Math.max(bars.bottom, ime.bottom));
                return WindowInsets.CONSUMED;
            });
        }
        try { webView = new WebView(this); }
        catch (RuntimeException ignored) {
            TextView message = new TextView(this); message.setText("请更新 Android 系统 WebView 后重新打开应用。");
            message.setTextSize(18); message.setPadding(24, 48, 24, 24); container.addView(message); return;
        }
        container.addView(webView, new FrameLayout.LayoutParams(-1, -1));
        loadPanel = new LinearLayout(this);
        loadPanel.setOrientation(LinearLayout.VERTICAL);
        loadPanel.setGravity(Gravity.CENTER);
        int padding = Math.round(24 * getResources().getDisplayMetrics().density);
        loadPanel.setPadding(padding, padding, padding, padding);
        loadPanel.setBackgroundColor(Color.rgb(243, 246, 247));
        loadProgress = new ProgressBar(this);
        loadPanel.addView(loadProgress);
        loadMessage = new TextView(this);
        loadMessage.setTextSize(17);
        loadMessage.setGravity(Gravity.CENTER);
        loadMessage.setTextColor(Color.rgb(41, 57, 64));
        loadMessage.setPadding(0, padding, 0, padding);
        loadPanel.addView(loadMessage);
        retryButton = new Button(this);
        retryButton.setText("重新连接");
        retryButton.setOnClickListener(view -> loadWebsite());
        loadPanel.addView(retryButton);
        container.addView(loadPanel, new FrameLayout.LayoutParams(-1, -1));
        webView.setBackgroundColor(Color.rgb(237, 247, 243));
        WebSettings settings = webView.getSettings();
        settings.setJavaScriptEnabled(true); settings.setDomStorageEnabled(true);
        settings.setAllowFileAccess(false); settings.setAllowContentAccess(false);
        settings.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        settings.setJavaScriptCanOpenWindowsAutomatically(false); settings.setSupportMultipleWindows(true);
        settings.setSafeBrowsingEnabled(true); settings.setSaveFormData(false);
        settings.setMediaPlaybackRequiresUserGesture(true);
        settings.setUserAgentString(settings.getUserAgentString() + " ContentWorkbench/" + BuildConfig.VERSION_NAME);
        CookieManager.getInstance().setAcceptCookie(true);
        CookieManager.getInstance().setAcceptThirdPartyCookies(webView, false);
        WebView.setWebContentsDebuggingEnabled(BuildConfig.DEBUG);
        // UI and data use the existing website. No bundled HTML can pin the app
        // to an older release; the gateway keeps its Cookie/Origin/CSRF checks.
        webView.setWebViewClient(new WebViewClient() {
            @Override public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
                String url = request.getUrl().toString();
                if (policy.gateway(url, request.getMethod()) && !request.isForMainFrame()) return null;
                if (policy.asset(url) && "GET".equals(request.getMethod())
                    && (!request.isForMainFrame() || policy.page(url))) return null;
                // Cover/avatar requests have no native bridge or third-party cookies.
                if (!request.isForMainFrame() && "GET".equals(request.getMethod()) && !policy.sameOrigin(url) && policy.external(url)) return null;
                return blocked(403);
            }
            @Override public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                String url = request.getUrl().toString();
                if (request.isForMainFrame() && policy.page(url)) return false;
                if (request.isForMainFrame() && request.hasGesture() && !policy.sameOrigin(url)) openExternal(url);
                return true;
            }
            @Override public void onReceivedSslError(WebView view, SslErrorHandler handler, SslError error) { handler.cancel(); }
            @Override public void onPageStarted(WebView view, String url, Bitmap favicon) {
                pageFailed = false;
                showLoadState(false);
            }
            @Override public void onPageCommitVisible(WebView view, String url) {
                if (!pageFailed) loadPanel.setVisibility(View.GONE);
            }
            @Override public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
                if (request.isForMainFrame()) { pageFailed = true; showLoadState(true); }
            }
            @Override public void onReceivedHttpError(WebView view, WebResourceRequest request, WebResourceResponse response) {
                if (request.isForMainFrame()) { pageFailed = true; showLoadState(true); }
            }
            @Override public void onPageFinished(WebView view, String url) {
                CookieManager.getInstance().flush();
                if (!pageFailed) loadPanel.setVisibility(View.GONE);
            }
        });
        webView.setWebChromeClient(new WebChromeClient() {
            @Override public void onShowCustomView(View view, CustomViewCallback callback) {
                if (fullScreen != null) { callback.onCustomViewHidden(); return; }
                fullScreen = view;
                fullScreenCallback = callback;
                container.addView(view, new FrameLayout.LayoutParams(-1, -1));
                webView.setVisibility(View.GONE);
                if (Build.VERSION.SDK_INT >= 30) {
                    WindowInsetsController controller = getWindow().getInsetsController();
                    if (controller != null) {
                        controller.setSystemBarsBehavior(WindowInsetsController.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE);
                        controller.hide(WindowInsets.Type.systemBars());
                    }
                }
            }
            @Override public void onHideCustomView() { closeFullScreen(); }
            @Override public boolean onJsConfirm(WebView view, String url, String message, JsResult result) {
                if (!policy.page(url)) { result.cancel(); return true; }
                new android.app.AlertDialog.Builder(MainActivity.this).setMessage(message)
                    .setPositiveButton("确定", (dialog, which) -> result.confirm())
                    .setNegativeButton("取消", (dialog, which) -> result.cancel()).setOnCancelListener(dialog -> result.cancel()).show();
                return true;
            }
            @Override public boolean onCreateWindow(WebView view, boolean dialog, boolean userGesture, Message result) {
                if (!userGesture) return false;
                WebView popup = new WebView(MainActivity.this);
                popup.setWebViewClient(new WebViewClient() {
                    @Override public boolean shouldOverrideUrlLoading(WebView v, WebResourceRequest request) {
                        openExternal(request.getUrl().toString()); v.destroy(); return true;
                    }
                });
                ((WebView.WebViewTransport) result.obj).setWebView(popup); result.sendToTarget(); return true;
            }
        });
        if (Build.VERSION.SDK_INT >= 33) getOnBackInvokedDispatcher().registerOnBackInvokedCallback(OnBackInvokedDispatcher.PRIORITY_DEFAULT, this::handleBack);
        loadWebsite();
    }
    private void loadWebsite() {
        pageFailed = false;
        showLoadState(false);
        // Revalidate the page on launch/retry while retaining hashed resources
        // and the existing login session. Never clear cookies or saved user data.
        webView.loadUrl(BuildConfig.WORKBENCH_ORIGIN + "/", Collections.singletonMap("Cache-Control", "no-cache"));
    }
    private void showLoadState(boolean failed) {
        loadMessage.setText(failed ? "暂时无法连接网站，请稍后重试。" : "正在打开工作台…");
        loadProgress.setVisibility(failed ? View.GONE : View.VISIBLE);
        retryButton.setVisibility(failed ? View.VISIBLE : View.GONE);
        loadPanel.setVisibility(View.VISIBLE);
    }
    private void closeFullScreen() {
        if (fullScreen == null) return;
        ((FrameLayout) fullScreen.getParent()).removeView(fullScreen);
        fullScreen = null;
        webView.setVisibility(View.VISIBLE);
        WebChromeClient.CustomViewCallback callback = fullScreenCallback;
        fullScreenCallback = null;
        callback.onCustomViewHidden();
        if (Build.VERSION.SDK_INT >= 30 && getWindow().getInsetsController() != null)
            getWindow().getInsetsController().show(WindowInsets.Type.systemBars());
    }
    private static WebResourceResponse blocked(int status) {
        return new WebResourceResponse("text/plain", "UTF-8", status, status == 404 ? "Not Found" : "Forbidden", Collections.singletonMap("Cache-Control", "no-store"), new ByteArrayInputStream(new byte[0]));
    }
    private void openExternal(String url) {
        if (!policy.external(url) || policy.sameOrigin(url)) return;
        try { startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse(url)).addCategory(Intent.CATEGORY_BROWSABLE)); }
        catch (ActivityNotFoundException ignored) { Toast.makeText(this, "没有可打开此链接的应用。", Toast.LENGTH_SHORT).show(); }
    }
    @Override public void onBackPressed() { handleBack(); }
    private void handleBack() {
        if (fullScreen != null) { closeFullScreen(); return; }
        if (webView == null || !policy.page(webView.getUrl())) { finish(); return; }
        webView.evaluateJavascript("(() => {const visible=e=>e&&e.getClientRects().length;for(const s of ['.readerClose','.modalClose','.previewBack','.mobileAccountSwitch[aria-expanded=true]']){const b=document.querySelector(s);if(visible(b)){b.click();return true;}}const d=document.querySelector('details[open]');if(d){d.open=false;return true;}const n=document.querySelector('.navigation .navItem');if(n&&!n.classList.contains('active')){n.click();return true;}return false;})()", handled -> {
            if ("true".equals(handled)) { backAt = 0; return; }
            long now = SystemClock.elapsedRealtime();
            if (backAt > 0 && now - backAt < 2000) finish();
            else { backAt = now; Toast.makeText(this, "再按一次返回退出", Toast.LENGTH_SHORT).show(); }
        });
    }
    @Override protected void onResume() {
        super.onResume();
        if (webView != null) { webView.onResume(); if (policy.page(webView.getUrl())) webView.evaluateJavascript("window.dispatchEvent(new Event('focus'))", null); }
    }
    @Override protected void onPause() { if (webView != null) webView.onPause(); CookieManager.getInstance().flush(); super.onPause(); }
    @Override protected void onDestroy() { if (webView != null) { webView.stopLoading(); webView.destroy(); webView = null; } super.onDestroy(); }
}
