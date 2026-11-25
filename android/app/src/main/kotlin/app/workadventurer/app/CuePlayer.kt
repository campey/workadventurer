package app.workadventurer.app

import android.content.Context
import android.media.AudioAttributes
import android.media.SoundPool
import android.util.Log
import app.workadventurer.app.ui.Cue

/**
 * Plays the chimes WorkAdventure's web client plays as people come and go (#134), on the call's audio stream so they follow its
 * volume and routing. The four short files are in res/raw (credited in THIRD_PARTY.md). Never throws: a missing sound is silence.
 */
class CuePlayer(context: Context) {
    private val pool = SoundPool.Builder()
        .setMaxStreams(2)
        .setAudioAttributes(
            AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_VOICE_COMMUNICATION).setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION).build(),
        ).build()
    private val ids = HashMap<Cue, Int>()
    private val ready = HashSet<Int>()

    init {
        pool.setOnLoadCompleteListener { _, id, status -> if (status == 0) synchronized(ready) { ready += id } }
        try {
            ids[Cue.BubbleIn] = pool.load(context, R.raw.webrtc_in_ding, 1)
            ids[Cue.BubbleOut] = pool.load(context, R.raw.webrtc_out_ding, 1)
            ids[Cue.MeetingIn] = pool.load(context, R.raw.meeting_in, 1)
            ids[Cue.MeetingOut] = pool.load(context, R.raw.meeting_out, 1)
        } catch (t: Throwable) {
            Log.w("WaCue", "chimes did not load: ${t.message}")
        }
    }

    fun play(cue: Cue) {
        val id = ids[cue] ?: return
        if (synchronized(ready) { id !in ready }) return
        try { pool.play(id, 1f, 1f, 1, 0, 1f); Log.i("WaCue", "chime $cue") } catch (t: Throwable) { Log.w("WaCue", "chime failed: ${t.message}") }
    }

    fun release() = pool.release()
}
