package jp.kenji.harness;

import android.Manifest;
import android.app.Activity;
import android.app.AlertDialog;
import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.graphics.Bitmap;
import android.graphics.Color;
import android.net.Uri;
import android.os.Bundle;
import android.text.InputType;
import android.view.View;
import android.view.Window;
import android.webkit.CookieManager;
import android.webkit.PermissionRequest;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.EditText;
import android.widget.FrameLayout;
import android.widget.ProgressBar;

import java.util.HashMap;
import java.util.Map;

/**
 * Kenji Harness: shows the dsh Web UI served by the Kenji gateway in a full-screen WebView.
 * Native glue covers what a plain WebView lacks: file choosers for attachments, microphone
 * permission for voice input, persistent cookies, the back button, external links and the
 * server URL setting.
 */
public class MainActivity extends Activity {
    private static final String PREFS = "kenji-harness";
    private static final String KEY_URL = "url";
    private static final String DEFAULT_URL = "https://talisman-delighted-anteater.ngrok-free.dev/harness/";
    private static final int REQ_FILE = 1;
    private static final int REQ_AUDIO = 2;
    /** A non-browser user agent keeps ngrok's free-tier browser interstitial away. */
    private static final String UA_SUFFIX = " KenjiHarnessApp/1.0";

    private WebView web;
    private ProgressBar progress;
    private ValueCallback<Uri[]> fileCallback;
    private PermissionRequest pendingPermission;
    private boolean showingError;

    @Override
    protected void onCreate(Bundle state) {
        super.onCreate(state);
        Window window = getWindow();
        window.setStatusBarColor(Color.parseColor("#181818"));
        window.setNavigationBarColor(Color.parseColor("#181818"));

        FrameLayout root = new FrameLayout(this);
        root.setBackgroundColor(Color.parseColor("#181818"));
        web = new WebView(this);
        progress = new ProgressBar(this, null, android.R.attr.progressBarStyleHorizontal);
        progress.setIndeterminate(true);
        progress.setVisibility(View.GONE);
        root.addView(web, new FrameLayout.LayoutParams(-1, -1));
        root.addView(progress, new FrameLayout.LayoutParams(-1, 8));
        setContentView(root);

        CookieManager cookies = CookieManager.getInstance();
        cookies.setAcceptCookie(true);
        cookies.setAcceptThirdPartyCookies(web, false);

        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setDatabaseEnabled(true);
        s.setMediaPlaybackRequiresUserGesture(false);
        s.setAllowFileAccess(false);
        s.setSupportMultipleWindows(false);
        s.setUserAgentString(s.getUserAgentString().replace("Mozilla/5.0 ", "") + UA_SUFFIX);

        web.setWebViewClient(new HarnessClient());
        web.setWebChromeClient(new HarnessChrome());
        if (state != null) web.restoreState(state);
        else load(serverUrl());
    }

    private String serverUrl() {
        return getSharedPreferences(PREFS, MODE_PRIVATE).getString(KEY_URL, DEFAULT_URL);
    }

    private void load(String url) {
        Map<String, String> headers = new HashMap<>();
        headers.put("ngrok-skip-browser-warning", "1");
        showingError = false;
        web.loadUrl(url, headers);
    }

    private boolean sameServer(Uri target) {
        Uri base = Uri.parse(serverUrl());
        return target.getHost() != null && target.getHost().equalsIgnoreCase(base.getHost())
            && (target.getScheme() == null || target.getScheme().equalsIgnoreCase(base.getScheme()));
    }

    private void openExternal(Uri uri) {
        try {
            startActivity(new Intent(Intent.ACTION_VIEW, uri));
        } catch (ActivityNotFoundException ignored) {
            // No app can open this link; staying on the current page is the only option.
        }
    }

    private void askServerUrl() {
        final EditText input = new EditText(this);
        input.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_URI);
        input.setText(serverUrl());
        input.setSelectAllOnFocus(true);
        new AlertDialog.Builder(this)
            .setTitle("接続先 URL")
            .setMessage("Kenji の Harness の URL を入力します（例: https://example.ngrok-free.dev/harness/）")
            .setView(input)
            .setPositiveButton("保存して開く", (d, w) -> {
                String url = input.getText().toString().trim();
                if (!url.isEmpty()) {
                    if (!url.endsWith("/")) url = url + "/";
                    getSharedPreferences(PREFS, MODE_PRIVATE).edit().putString(KEY_URL, url).apply();
                    load(url);
                }
            })
            .setNeutralButton("既定に戻す", (d, w) -> {
                getSharedPreferences(PREFS, MODE_PRIVATE).edit().remove(KEY_URL).apply();
                load(DEFAULT_URL);
            })
            .setNegativeButton("キャンセル", null)
            .show();
    }

    private void showMenu() {
        String[] items = {"再読み込み", "接続先 URL を変更", "ログアウト", "アプリを閉じる"};
        new AlertDialog.Builder(this)
            .setItems(items, (d, which) -> {
                if (which == 0) load(showingError ? serverUrl() : web.getUrl() != null ? web.getUrl() : serverUrl());
                else if (which == 1) askServerUrl();
                else if (which == 2) load(serverUrl() + "logout");
                else finish();
            })
            .show();
    }

    private void showError(String detail) {
        showingError = true;
        String html = "<!doctype html><html lang='ja'><meta name='viewport' content='width=device-width,initial-scale=1'>"
            + "<body style='margin:0;background:#181818;color:#f4f4f5;font:15px/1.7 sans-serif;display:flex;align-items:center;justify-content:center;height:100vh'>"
            + "<div style='padding:24px;max-width:340px'><h2 style='font-size:19px;margin:0 0 8px'>Harness に接続できません</h2>"
            + "<p style='color:#a1a1aa;margin:0 0 16px'>PC の Kenji と ngrok が動いているか、接続先 URL が正しいかを確認してください。</p>"
            + "<p style='color:#71717a;font-size:12px;word-break:break-all'>" + escape(serverUrl()) + "<br>" + escape(detail) + "</p>"
            + "<p style='color:#a1a1aa;font-size:13px'>戻るボタンで「再読み込み」や「接続先 URL を変更」を選べます。</p></div></body></html>";
        web.loadDataWithBaseURL(null, html, "text/html", "utf-8", null);
    }

    private static String escape(String s) {
        return s == null ? "" : s.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;");
    }

    @Override
    public void onBackPressed() {
        if (!showingError && web.canGoBack()) web.goBack();
        else showMenu();
    }

    @Override
    protected void onSaveInstanceState(Bundle out) {
        super.onSaveInstanceState(out);
        web.saveState(out);
    }

    @Override
    protected void onPause() {
        super.onPause();
        CookieManager.getInstance().flush();
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        if (requestCode != REQ_FILE || fileCallback == null) return;
        Uri[] result = null;
        if (resultCode == RESULT_OK && data != null) {
            if (data.getClipData() != null) {
                int n = data.getClipData().getItemCount();
                result = new Uri[n];
                for (int i = 0; i < n; i++) result[i] = data.getClipData().getItemAt(i).getUri();
            } else if (data.getData() != null) {
                result = new Uri[]{data.getData()};
            }
        }
        fileCallback.onReceiveValue(result);
        fileCallback = null;
    }

    @Override
    public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] results) {
        if (requestCode != REQ_AUDIO || pendingPermission == null) return;
        if (results.length > 0 && results[0] == PackageManager.PERMISSION_GRANTED) {
            pendingPermission.grant(new String[]{PermissionRequest.RESOURCE_AUDIO_CAPTURE});
        } else {
            pendingPermission.deny();
        }
        pendingPermission = null;
    }

    private class HarnessClient extends WebViewClient {
        @Override
        public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
            Uri uri = request.getUrl();
            String scheme = uri.getScheme();
            if (("http".equals(scheme) || "https".equals(scheme)) && sameServer(uri)) return false;
            openExternal(uri);
            return true;
        }

        @Override
        public void onPageStarted(WebView view, String url, Bitmap favicon) {
            progress.setVisibility(View.VISIBLE);
        }

        @Override
        public void onPageFinished(WebView view, String url) {
            progress.setVisibility(View.GONE);
            CookieManager.getInstance().flush();
        }

        @Override
        public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
            if (request.isForMainFrame()) showError(String.valueOf(error.getDescription()));
        }
    }

    private class HarnessChrome extends WebChromeClient {
        @Override
        public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> callback, FileChooserParams params) {
            if (fileCallback != null) fileCallback.onReceiveValue(null);
            fileCallback = callback;
            Intent intent = new Intent(Intent.ACTION_GET_CONTENT);
            intent.addCategory(Intent.CATEGORY_OPENABLE);
            String[] types = params.getAcceptTypes();
            String type = types != null && types.length == 1 && !types[0].isEmpty() ? types[0] : "*/*";
            intent.setType(type);
            if (params.getMode() == FileChooserParams.MODE_OPEN_MULTIPLE) intent.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true);
            try {
                startActivityForResult(Intent.createChooser(intent, "ファイルを選択"), REQ_FILE);
                return true;
            } catch (ActivityNotFoundException e) {
                fileCallback = null;
                return false;
            }
        }

        @Override
        public void onPermissionRequest(PermissionRequest request) {
            boolean audioOnly = true;
            for (String r : request.getResources()) if (!PermissionRequest.RESOURCE_AUDIO_CAPTURE.equals(r)) audioOnly = false;
            if (!audioOnly) {
                request.deny();
                return;
            }
            if (checkSelfPermission(Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED) {
                request.grant(new String[]{PermissionRequest.RESOURCE_AUDIO_CAPTURE});
            } else {
                pendingPermission = request;
                requestPermissions(new String[]{Manifest.permission.RECORD_AUDIO}, REQ_AUDIO);
            }
        }
    }
}
