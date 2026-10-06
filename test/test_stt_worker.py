import os
import sys
import unittest

import numpy as np

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "scripts"))
import stt_worker as w  # noqa: E402


class FillerOnly(unittest.TestCase):
    def test_standalone_fillers(self):
        for t in ["Thank you.", "Okay.", "Um...", "Thanks for watching!", "Thank you. Thank you very much.", "Yeah."]:
            self.assertTrue(w.is_filler_only(t), t)

    def test_real_content_is_not_filler(self):
        for t in ["Okay, let's meet at the fire pit.", "Thank you for the map", "yeah I think so"]:
            self.assertFalse(w.is_filler_only(t), t)

    def test_empty_is_not_filler(self):
        self.assertFalse(w.is_filler_only(""))


class CollapseRepetition(unittest.TestCase):
    def test_existing_word_loop_still_collapses(self):
        self.assertEqual(w.collapse_repetition("hi " + "fucking " * 10), "hi fucking fucking …")

    def test_no_space_substring_loop_collapses(self):
        self.assertEqual(w.collapse_repetition("I bar" + "do" * 40), "I bardodo …")

    def test_single_char_run_collapses(self):
        self.assertEqual(w.collapse_repetition("kyb" + "b" * 60), "kybb …")

    def test_normal_text_untouched(self):
        for t in ["Okay, hahaha that was funny", "sooooo wait... what", "It's a stage where we work."]:
            self.assertEqual(w.collapse_repetition(t), t)


class UndecodableBytes(unittest.TestCase):
    def test_replacement_chars_are_stripped(self):
        s = w.MicSession(lambda a: {"text": " Yeah���� Yeah", "segments": []})
        s.buf = np.full(16000, 0.2, dtype=np.float32)
        self.assertEqual(s.transcribe_current()["text"], "Yeah Yeah")


class LoudestWindow(unittest.TestCase):
    def test_loudest_100ms_window_rms(self):
        quiet = np.full(16000, 0.01, dtype=np.float32)
        loud = np.full(1600, 0.2, dtype=np.float32)
        buf = np.concatenate([quiet, loud, quiet])
        self.assertAlmostEqual(w.loudest_window_rms(buf), 0.2, places=3)

    def test_short_buffer(self):
        self.assertAlmostEqual(w.loudest_window_rms(np.full(500, 0.1, dtype=np.float32)), 0.1, places=3)


class FillerGate(unittest.TestCase):
    def _session(self, level):
        s = w.MicSession(lambda audio: {"text": " Thank you.", "segments": []})
        s.buf = np.full(16000, level, dtype=np.float32)
        return s

    def test_quiet_filler_is_dropped(self):
        self.assertEqual(self._session(0.03).transcribe_current()["text"], "")

    def test_loud_filler_is_kept(self):
        self.assertEqual(self._session(0.2).transcribe_current()["text"], "Thank you.")


class DecodeOptions(unittest.TestCase):
    def test_defaults_are_greedy_english(self):
        self.assertEqual(w.decode_options({}), {"temperature": 0.0, "language": "en"})

    def test_language_auto_restores_detection(self):
        self.assertEqual(w.decode_options({"STT_LANGUAGE": "auto"}), {"temperature": 0.0})

    def test_env_overrides(self):
        o = w.decode_options({"STT_LANGUAGE": "en", "STT_TEMPERATURE": "0.2", "STT_LOGPROB_THRESHOLD": "-0.8"})
        self.assertEqual(o, {"language": "en", "temperature": 0.2, "logprob_threshold": -0.8})


if __name__ == "__main__":
    unittest.main()
