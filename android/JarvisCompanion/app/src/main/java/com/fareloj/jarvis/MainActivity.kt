package com.fareloj.jarvis

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.lifecycle.viewmodel.compose.viewModel

class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContent {
            JarvisTheme {
                val model: JarvisViewModel = viewModel()
                JarvisApp(model)
            }
        }
    }
}
