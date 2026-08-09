package com.gbclstudio.gmplayer

import android.Manifest
import android.content.pm.PackageManager
import android.os.Build
import android.os.Bundle
import android.util.Log
import android.view.View
import android.webkit.JavascriptInterface
import android.webkit.WebView
import androidx.activity.enableEdgeToEdge
import androidx.activity.result.contract.ActivityResultContracts
import androidx.core.content.ContextCompat
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import java.util.Locale

class MainActivity : TauriActivity() {

    private var webView: WebView? = null
    private var lastInsetsCss: String? = null

    // 申请通知权限（Android 13+ 必需）
    private val requestPermissionLauncher = registerForActivityResult(
        ActivityResultContracts.RequestPermission()
    ) { isGranted: Boolean ->
        if (isGranted) {
            Log.d("MainActivity", "Notification permission granted")
        } else {
            Log.w("MainActivity", "Notification permission denied")
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        // 启用全屏设计
        enableEdgeToEdge()
        super.onCreate(savedInstanceState)

        val rootView = findViewById<View>(R.id.main) ?: findViewById<View>(android.R.id.content)

        // Edge-to-edge 安全区处理。
        //
        // 这里必须把 inset 主动推给 WebView：Android WebView 的 env(safe-area-inset-*)
        // 只反映 display cutout（刘海/挖孔），从不包含状态栏与底部手势条。所以在
        // enableEdgeToEdge() 之下，底部手势条实际占着位置，而 CSS 侧
        // env(safe-area-inset-bottom) 仍然是 0 —— 这就是移动端底栏偏移量的来源。
        // 用 systemBars + displayCutout 的并集覆盖 --app-safe-area-*，让 CSS 拿到真值。
        ViewCompat.setOnApplyWindowInsetsListener(rootView) { v, insets ->
            publishSafeAreaInsets(insets)
            ViewCompat.onApplyWindowInsets(v, insets)
        }

        checkAndRequestPermissions()
    }

    override fun onWebViewCreate(webView: WebView) {
        this.webView = webView
        // 拉取通道。推送依赖 document 已经存在，而首次 inset 回调可能早于文档解析完成，
        // 那一次推送会静默丢失。暴露一个同步 getter，让前端启动时能主动兜底读一次。
        webView.addJavascriptInterface(SafeAreaBridge(), "AndroidSafeArea")
        lastInsetsCss?.let { pushSafeAreaCss(it) }
    }

    private inner class SafeAreaBridge {
        /** "top,right,bottom,left"，单位 CSS px；尚无数据时返回空串。 */
        @JavascriptInterface
        fun get(): String = lastInsetsCss ?: ""
    }

    private fun publishSafeAreaInsets(insets: WindowInsetsCompat) {
        val bars = insets.getInsets(
            WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout()
        )
        val density = resources.displayMetrics.density.takeIf { it > 0f } ?: 1f
        // px -> CSS px。WebView 的 CSS 像素跟 density 挂钩，直接用原始 px 会在
        // 高 DPI 设备上放大好几倍。
        val css = String.format(
            Locale.US,
            "%.2f,%.2f,%.2f,%.2f",
            bars.top / density,
            bars.right / density,
            bars.bottom / density,
            bars.left / density,
        )
        if (css == lastInsetsCss) return
        lastInsetsCss = css
        pushSafeAreaCss(css)
    }

    private fun pushSafeAreaCss(css: String) {
        val view = webView ?: return
        val parts = css.split(",")
        if (parts.size != 4) return
        val script = """
            (function(){
              var r = document.documentElement;
              if (!r) return;
              r.style.setProperty('--app-safe-area-top', '${parts[0]}px');
              r.style.setProperty('--app-safe-area-right', '${parts[1]}px');
              r.style.setProperty('--app-safe-area-bottom', '${parts[2]}px');
              r.style.setProperty('--app-safe-area-left', '${parts[3]}px');
            })();
        """.trimIndent()
        view.post { view.evaluateJavascript(script, null) }
    }

    private fun checkAndRequestPermissions() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            if (ContextCompat.checkSelfPermission(
                    this,
                    Manifest.permission.POST_NOTIFICATIONS
                ) != PackageManager.PERMISSION_GRANTED
            ) {
                requestPermissionLauncher.launch(Manifest.permission.POST_NOTIFICATIONS)
            }
        }
    }
}
