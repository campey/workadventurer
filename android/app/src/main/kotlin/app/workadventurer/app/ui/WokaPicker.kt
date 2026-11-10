package app.workadventurer.app.ui

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.grid.GridCells
import androidx.compose.foundation.lazy.grid.GridItemSpan
import androidx.compose.foundation.lazy.grid.LazyVerticalGrid
import androidx.compose.foundation.lazy.grid.items
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import app.workadventurer.protocol.RoomConfig
import app.workadventurer.protocol.Texture
import app.workadventurer.protocol.WokaCatalogue
import app.workadventurer.protocol.WokaTexture

const val WOKA_PICKER_TITLE = "Choose your woka"

/** One collection of whole wokas under its own heading. */
data class WokaSection(val title: String, val wokas: List<WokaTexture>)

/** The catalogue's whole characters by collection; a collection with nothing in it gets no heading. Layers to compose from come later. */
fun wokaSections(c: WokaCatalogue): List<WokaSection> =
    c.wokas.filter { it.textures.isNotEmpty() }.map { WokaSection(it.name, it.textures) }

/** The woka shown as selected: the one you chose, else what a join sends when nothing is chosen (the server's default). */
fun selectedWokaId(chosen: Texture?, roomUrl: String): String = chosen?.id ?: RoomConfig.forRoom("", roomUrl).wokaId

fun wokaCellDescription(name: String, selected: Boolean): String =
    (name.ifBlank { "Unnamed woka" }) + if (selected) ", selected" else ""

/** The picture to draw for a catalogue entry: the woka's own spritesheet. */
fun wokaTexture(w: WokaTexture) = Texture(w.id, w.url)

/** What the picker shows while the catalogue is on its way (or failed). */
sealed interface WokaCatalogueState {
    data object Loading : WokaCatalogueState
    data class Failed(val message: String) : WokaCatalogueState
    data class Loaded(val catalogue: WokaCatalogue) : WokaCatalogueState
}

/**
 * The woka picker (#108): every whole woka the room's server offers, by collection, with the selected one outlined. Tapping one
 * chooses it and goes back. The catalogue is fetched on opening ([load]), with a retry when it fails.
 */
@Composable
fun WokaPickerScreen(
    roomUrl: String, chosen: Texture?, load: suspend (roomUrl: String) -> Result<WokaCatalogue>,
    onChoose: (WokaTexture) -> Unit, onBack: () -> Unit,
) {
    var attempt by remember { mutableStateOf(0) }
    var state by remember { mutableStateOf<WokaCatalogueState>(WokaCatalogueState.Loading) }
    LaunchedEffect(roomUrl, attempt) {
        state = WokaCatalogueState.Loading
        state = load(roomUrl).fold(
            onSuccess = { WokaCatalogueState.Loaded(it) },
            onFailure = { WokaCatalogueState.Failed(it.message ?: "something went wrong") },
        )
    }
    val selected = selectedWokaId(chosen, roomUrl)

    Column(Modifier.fillMaxSize()) {
        Row(Modifier.fillMaxWidth().heightIn(min = 56.dp).padding(horizontal = 4.dp), verticalAlignment = Alignment.CenterVertically) {
            IconButton(onClick = onBack, modifier = Modifier.size(48.dp).semantics { contentDescription = "Back without changing your woka" }) {
                Icon(WaIcons.ArrowBack, contentDescription = null)
            }
            Text(WOKA_PICKER_TITLE, style = MaterialTheme.typography.titleLarge, modifier = Modifier.padding(start = 8.dp).semantics { heading() })
        }
        when (val s = state) {
            WokaCatalogueState.Loading -> Column(
                Modifier.weight(1f).fillMaxWidth().padding(24.dp).semantics { liveRegion = LiveRegionMode.Polite },
                horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.Center,
            ) {
                CircularProgressIndicator()
                Text("Loading the wokas…", style = MaterialTheme.typography.bodyLarge, modifier = Modifier.padding(top = 16.dp))
            }
            is WokaCatalogueState.Failed -> Column(
                Modifier.weight(1f).fillMaxWidth().padding(24.dp).semantics { liveRegion = LiveRegionMode.Polite },
                horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.Center,
            ) {
                Text("Couldn't load the wokas: ${s.message}", style = MaterialTheme.typography.bodyLarge, textAlign = TextAlign.Center, color = MaterialTheme.colorScheme.error)
                OutlinedButton(onClick = { attempt++ }, modifier = Modifier.padding(top = 16.dp).heightIn(min = 48.dp)) { Text("Try again") }
            }
            is WokaCatalogueState.Loaded -> WokaGrid(wokaSections(s.catalogue), selected, onChoose)
        }
    }
}

@Composable
private fun WokaGrid(sections: List<WokaSection>, selectedId: String, onChoose: (WokaTexture) -> Unit) {
    LazyVerticalGrid(
        columns = GridCells.Adaptive(minSize = 88.dp), modifier = Modifier.fillMaxSize(),
        contentPadding = PaddingValues(horizontal = 16.dp, vertical = 8.dp),
        horizontalArrangement = Arrangement.spacedBy(8.dp), verticalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        sections.forEach { section ->
            item(span = { GridItemSpan(maxLineSpan) }, key = "section-${section.title}") {
                Text(
                    section.title.uppercase(), style = MaterialTheme.typography.labelLarge, color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.78f),
                    modifier = Modifier.padding(top = 12.dp, bottom = 4.dp, start = 4.dp).semantics { heading() },
                )
            }
            items(section.wokas, key = { "${section.title}/${it.id}" }) { w ->
                val isSelected = w.id == selectedId
                Surface(
                    shape = RoundedCornerShape(16.dp), color = MaterialTheme.colorScheme.surface,
                    border = BorderStroke(if (isSelected) 3.dp else 1.dp, if (isSelected) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.outline.copy(alpha = 0.5f)),
                    modifier = Modifier.selectable(selected = isSelected, role = Role.RadioButton, onClick = { onChoose(w) })
                        .semantics { contentDescription = wokaCellDescription(w.name, isSelected) },
                ) {
                    Column(Modifier.padding(8.dp), horizontalAlignment = Alignment.CenterHorizontally) {
                        WokaAvatar(listOf(wokaTexture(w)), w.name, 64.dp, plain = true)
                        Text(
                            w.name.ifBlank { "Unnamed" }, style = MaterialTheme.typography.bodySmall, maxLines = 1, overflow = TextOverflow.Ellipsis,
                            modifier = Modifier.padding(top = 4.dp),
                        )
                    }
                }
            }
        }
    }
}
