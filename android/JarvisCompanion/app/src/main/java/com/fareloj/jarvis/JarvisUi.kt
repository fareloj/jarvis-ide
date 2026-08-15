package com.fareloj.jarvis

import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import kotlinx.coroutines.launch

private val Ink = Color(0xFF201E1D)
private val Paper = Color(0xFFF7F5F3)
private val Panel = Color(0xFFEFEBE8)
private val Border = Color(0xFFD9D3CF)
private val Accent = Color(0xFF0098C2)
private val Muted = Color(0xFF817A75)
private val UserBubble = Color(0xFFE7F5FA)

@Composable
fun JarvisTheme(content: @Composable () -> Unit) {
    MaterialTheme(
        colorScheme = lightColorScheme(
            primary = Accent,
            onPrimary = Color.White,
            background = Paper,
            surface = Paper,
            surfaceVariant = Panel,
            outline = Border,
            onBackground = Ink,
            onSurface = Ink,
        ),
        typography = Typography(
            bodyLarge = androidx.compose.ui.text.TextStyle(fontFamily = FontFamily.SansSerif, fontSize = 16.sp, lineHeight = 24.sp),
            bodyMedium = androidx.compose.ui.text.TextStyle(fontFamily = FontFamily.SansSerif, fontSize = 14.sp, lineHeight = 21.sp),
            labelMedium = androidx.compose.ui.text.TextStyle(fontFamily = FontFamily.Monospace, fontSize = 12.sp),
        ),
        content = content,
    )
}

@Composable
fun JarvisApp(viewModel: JarvisViewModel) {
    val state = viewModel.state
    Surface(Modifier.fillMaxSize(), color = Paper) {
        when {
            !state.configured -> LoginScreen(state, viewModel::connect)
            state.connecting -> CenterStatus("Conectando ao seu PC…")
            !state.connected -> OfflineScreen(state.error, viewModel::retry, viewModel::logout)
            else -> ChatShell(viewModel)
        }
    }
}

@Composable
private fun LoginScreen(state: JarvisUiState, connect: (String, String) -> Unit) {
    var server by remember { mutableStateOf("") }
    var token by remember { mutableStateOf("") }
    Column(
        Modifier.fillMaxSize().padding(horizontal = 28.dp).verticalScroll(rememberScrollState()),
        verticalArrangement = Arrangement.Center,
    ) {
        Text("JARVIS", fontFamily = FontFamily.Serif, fontSize = 58.sp, color = Ink)
        Text("Seu contexto acompanha você.", fontFamily = FontFamily.Serif, fontStyle = FontStyle.Italic, fontSize = 20.sp, color = Muted)
        Spacer(Modifier.height(38.dp))
        Text("CONECTAR AO PC", fontFamily = FontFamily.Monospace, fontSize = 12.sp, color = Muted)
        Spacer(Modifier.height(12.dp))
        OutlinedTextField(server, { server = it }, Modifier.fillMaxWidth(), label = { Text("URL HTTPS do Tailscale") }, singleLine = true)
        Spacer(Modifier.height(10.dp))
        OutlinedTextField(token, { token = it }, Modifier.fillMaxWidth(), label = { Text("Token do JARVIS") }, singleLine = true)
        state.error?.let { Text(it, color = MaterialTheme.colorScheme.error, modifier = Modifier.padding(top = 10.dp)) }
        Spacer(Modifier.height(18.dp))
        Button(onClick = { connect(server, token) }, modifier = Modifier.fillMaxWidth(), enabled = !state.connecting) {
            Text(if (state.connecting) "Verificando…" else "Entrar")
        }
        Spacer(Modifier.height(16.dp))
        Text("O token fica criptografado no Android Keystore. Ollama, RAG e memória permanecem no seu PC.", style = MaterialTheme.typography.bodySmall, color = Muted)
    }
}

@Composable
private fun OfflineScreen(error: String?, retry: () -> Unit, logout: () -> Unit) {
    Column(Modifier.fillMaxSize().padding(28.dp), verticalArrangement = Arrangement.Center, horizontalAlignment = Alignment.CenterHorizontally) {
        Text("PC indisponível", fontFamily = FontFamily.Serif, fontSize = 30.sp)
        Spacer(Modifier.height(10.dp))
        Text(error ?: "Confira se o JARVIS e o Tailscale estão ativos.", color = Muted)
        Spacer(Modifier.height(20.dp))
        Button(onClick = retry) { Text("Tentar novamente") }
        TextButton(onClick = logout) { Text("Trocar conexão") }
    }
}

@Composable
private fun CenterStatus(text: String) {
    Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
        Column(horizontalAlignment = Alignment.CenterHorizontally) {
            CircularProgressIndicator(color = Accent)
            Spacer(Modifier.height(14.dp))
            Text(text, color = Muted)
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun ChatShell(viewModel: JarvisViewModel) {
    val state = viewModel.state
    val drawer = rememberDrawerState(DrawerValue.Closed)
    val scope = rememberCoroutineScope()
    var showModels by remember { mutableStateOf(false) }
    var showQuota by remember { mutableStateOf(false) }
    var showSettings by remember { mutableStateOf(false) }

    ModalNavigationDrawer(
        drawerState = drawer,
        drawerContent = {
            ModalDrawerSheet(drawerContainerColor = Panel, modifier = Modifier.width(310.dp)) {
                Row(Modifier.fillMaxWidth().padding(18.dp), horizontalArrangement = Arrangement.SpaceBetween, verticalAlignment = Alignment.CenterVertically) {
                    Text("CONVERSAS", fontFamily = FontFamily.Monospace, fontSize = 12.sp, color = Muted)
                    TextButton(onClick = { viewModel.newChat(); scope.launch { drawer.close() } }) { Text("＋ Nova") }
                }
                HorizontalDivider(color = Border)
                LazyColumn(Modifier.weight(1f)) {
                    items(state.conversations, key = { it.id }) { chat ->
                        Row(
                            Modifier.fillMaxWidth().clickable { viewModel.selectChat(chat.id); scope.launch { drawer.close() } }.padding(16.dp),
                            verticalAlignment = Alignment.CenterVertically,
                        ) {
                            Column(Modifier.weight(1f)) {
                                Text(chat.title, maxLines = 1, fontWeight = if (chat.id == state.currentId) FontWeight.Bold else FontWeight.Normal)
                                Text("${chat.messages.size} mensagens", style = MaterialTheme.typography.labelMedium, color = Muted)
                            }
                            TextButton(onClick = { viewModel.deleteChat(chat.id) }) { Text("Excluir", color = Muted) }
                        }
                    }
                }
                HorizontalDivider(color = Border)
                TextButton(onClick = { showSettings = true; scope.launch { drawer.close() } }, modifier = Modifier.padding(8.dp)) { Text("Configuração") }
            }
        },
    ) {
        Scaffold(
            topBar = {
                TopAppBar(
                    title = {
                        Column {
                            Text("JARVIS", fontFamily = FontFamily.Serif, fontSize = 23.sp)
                            Text(viewModel.current?.title ?: "Nova conversa", style = MaterialTheme.typography.labelMedium, color = Muted, maxLines = 1)
                        }
                    },
                    navigationIcon = { TextButton(onClick = { scope.launch { drawer.open() } }) { Text("☰", fontSize = 22.sp) } },
                    actions = {
                        TextButton(onClick = { showQuota = true }) { Text(quotaLabel(state.quota), fontFamily = FontFamily.Monospace, fontSize = 11.sp) }
                        TextButton(onClick = { showModels = true }) { Text(state.models.firstOrNull { it.id == state.selectedModel }?.label ?: "Modelo", maxLines = 1) }
                    },
                    colors = TopAppBarDefaults.topAppBarColors(containerColor = Paper),
                )
            },
            bottomBar = { Composer(viewModel) },
            containerColor = Paper,
        ) { padding -> Messages(viewModel, Modifier.padding(padding)) }
    }
    if (showModels) ModelDialog(state, viewModel::selectModel) { showModels = false }
    if (showQuota) QuotaDialog(state.quota) { showQuota = false }
    if (showSettings) SettingsDialog(viewModel::logout) { showSettings = false }
}

private fun quotaLabel(quota: QuotaInfo): String = quota.sessionPercent?.let { "☁ ${it.toInt()}%" } ?: "☁ —"

@Composable
private fun Messages(viewModel: JarvisViewModel, modifier: Modifier) {
    val messages = viewModel.current?.messages.orEmpty()
    val listState = rememberLazyListState()
    LaunchedEffect(messages.size, messages.lastOrNull()?.content?.length) {
        if (messages.isNotEmpty()) listState.scrollToItem(messages.lastIndex)
    }
    if (messages.isEmpty()) {
        Box(modifier.fillMaxSize().padding(28.dp), contentAlignment = Alignment.Center) {
            Column(horizontalAlignment = Alignment.CenterHorizontally) {
                Text("JARVIS", fontFamily = FontFamily.Serif, fontSize = 44.sp)
                Text("Pergunte, pesquise e continue de onde parou.", color = Muted)
            }
        }
        return
    }
    LazyColumn(modifier.fillMaxSize(), state = listState, contentPadding = PaddingValues(horizontal = 16.dp, vertical = 18.dp), verticalArrangement = Arrangement.spacedBy(14.dp)) {
        items(messages, key = { it.id }) { message -> MessageCard(message, viewModel) }
    }
}

@Composable
private fun MessageCard(message: ChatMessage, viewModel: JarvisViewModel) {
    val context = LocalContext.current
    val user = message.role == MessageRole.USER
    Column(Modifier.fillMaxWidth(), horizontalAlignment = if (user) Alignment.End else Alignment.Start) {
        Text(if (user) "VOCÊ" else "JARVIS", fontFamily = FontFamily.Monospace, fontSize = 11.sp, color = if (user) Muted else Accent)
        Spacer(Modifier.height(4.dp))
        Surface(
            color = if (user) UserBubble else Color.Transparent,
            shape = RoundedCornerShape(16.dp),
            modifier = Modifier.widthIn(max = 680.dp),
        ) {
            SelectionContainer {
                Text(if (message.content.isBlank()) "Pensando…" else message.content, modifier = Modifier.padding(if (user) 13.dp else 5.dp), color = if (message.content.isBlank()) Muted else Ink)
            }
        }
        Row {
            TextButton(onClick = { copy(context, message.content) }, contentPadding = PaddingValues(horizontal = 7.dp)) { Text("Copiar", fontSize = 11.sp, color = Muted) }
            if (user) TextButton(onClick = { viewModel.beginEdit(message) }, contentPadding = PaddingValues(horizontal = 7.dp)) { Text("Editar", fontSize = 11.sp, color = Muted) }
            TextButton(onClick = { viewModel.deleteMessage(message.id) }, contentPadding = PaddingValues(horizontal = 7.dp)) { Text("Excluir", fontSize = 11.sp, color = Muted) }
        }
    }
}

@Composable
private fun Composer(viewModel: JarvisViewModel) {
    val state = viewModel.state
    var text by remember { mutableStateOf("") }
    val editing = state.editingMessageId?.let { id -> viewModel.current?.messages?.firstOrNull { it.id == id } }
    LaunchedEffect(state.editingMessageId) { if (editing != null) text = editing.content }
    Surface(color = Paper, shadowElevation = 8.dp) {
        Column(Modifier.fillMaxWidth().padding(12.dp)) {
            if (editing != null) Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
                Text("Editando mensagem — a resposta posterior será regenerada", style = MaterialTheme.typography.labelMedium, color = Accent)
                TextButton(onClick = { viewModel.cancelEdit(); text = "" }) { Text("Cancelar") }
            }
            OutlinedTextField(
                value = text,
                onValueChange = { text = it },
                modifier = Modifier.fillMaxWidth(),
                placeholder = { Text("Converse com o JARVIS…") },
                minLines = 2,
                maxLines = 6,
                trailingIcon = {
                    if (state.generating) TextButton(onClick = viewModel::stop) { Text("■") }
                    else Button(onClick = { viewModel.send(text); text = "" }, enabled = text.isNotBlank()) { Text("↑") }
                },
            )
            Row(verticalAlignment = Alignment.CenterVertically) {
                Switch(checked = state.researchEnabled, onCheckedChange = { viewModel.toggleResearch() })
                Text("Pesquisa web", style = MaterialTheme.typography.labelMedium, color = Muted)
            }
        }
    }
}

@Composable
private fun ModelDialog(state: JarvisUiState, select: (String) -> Unit, dismiss: () -> Unit) {
    var query by remember { mutableStateOf("") }
    val models = state.models.filter { query.isBlank() || it.label.contains(query, true) || it.id.contains(query, true) }
    AlertDialog(
        onDismissRequest = dismiss,
        title = { Text("Escolher modelo", fontFamily = FontFamily.Serif) },
        text = {
            Column {
                OutlinedTextField(query, { query = it }, Modifier.fillMaxWidth(), placeholder = { Text("Buscar modelos…") }, singleLine = true)
                Spacer(Modifier.height(10.dp))
                LazyColumn(Modifier.heightIn(max = 440.dp)) {
                    items(models, key = { it.id }) { model ->
                        Column(Modifier.fillMaxWidth().clickable { select(model.id); dismiss() }.padding(vertical = 12.dp)) {
                            Text(model.label, fontWeight = if (model.id == state.selectedModel) FontWeight.Bold else FontWeight.Normal)
                            Text(listOfNotNull(model.parameters, model.usageLevel, if (model.thinking) "thinking" else null, if (model.multimodal) "visão" else null).joinToString(" · "), style = MaterialTheme.typography.labelMedium, color = Muted)
                        }
                        HorizontalDivider(color = Border)
                    }
                }
            }
        },
        confirmButton = { TextButton(onClick = dismiss) { Text("Fechar") } },
    )
}

@Composable
private fun QuotaDialog(quota: QuotaInfo, dismiss: () -> Unit) {
    AlertDialog(
        onDismissRequest = dismiss,
        title = { Text("Ollama Cloud ${quota.plan}", fontFamily = FontFamily.Serif) },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(14.dp)) {
                QuotaBar("Sessão", quota.sessionPercent)
                QuotaBar("Semana", quota.weeklyPercent)
                quota.message?.let { Text(it, color = Muted) }
                Text("A sessão Ollama permanece protegida no PC.", style = MaterialTheme.typography.labelMedium, color = Muted)
            }
        },
        confirmButton = { TextButton(onClick = dismiss) { Text("Fechar") } },
    )
}

@Composable
private fun QuotaBar(label: String, value: Double?) {
    Column {
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) { Text(label); Text(value?.let { "${it.toInt()}%" } ?: "—") }
        Spacer(Modifier.height(5.dp))
        LinearProgressIndicator(progress = { ((value ?: 0.0) / 100.0).toFloat() }, modifier = Modifier.fillMaxWidth(), color = Accent, trackColor = Border)
    }
}

@Composable
private fun SettingsDialog(logout: () -> Unit, dismiss: () -> Unit) {
    AlertDialog(
        onDismissRequest = dismiss,
        title = { Text("Configuração") },
        text = { Text("A conexão usa HTTPS privado e token armazenado no Android Keystore. Para trocar o PC ou revogar este aparelho, remova a conexão.") },
        confirmButton = { TextButton(onClick = { dismiss(); logout() }) { Text("Remover conexão", color = MaterialTheme.colorScheme.error) } },
        dismissButton = { TextButton(onClick = dismiss) { Text("Cancelar") } },
    )
}

private fun copy(context: Context, text: String) {
    (context.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager).setPrimaryClip(ClipData.newPlainText("Mensagem JARVIS", text))
}
