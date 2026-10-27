package app.workadventurer.app.net

import app.workadventurer.app.KeyValueStore
import kotlin.test.Test
import kotlin.test.assertEquals

private class MapStore : KeyValueStore {
    val m = HashMap<String, String>()
    override fun get(key: String) = m[key]
    override fun put(key: String, value: String) { m[key] = value }
}

class RateMeterTest {
    @Test
    fun theRateIsBytesPerSecondSinceTheLastSample() {
        val r = RateMeter()
        assertEquals(0.0, r.sample(1_000, atMs = 0)) // nothing to compare with yet
        assertEquals(500.0, r.sample(2_000, atMs = 2_000))
        assertEquals(0.0, r.sample(2_000, atMs = 3_000))
    }

    @Test
    fun aCounterThatGoesBackwardsRestartsTheMeterInsteadOfGoingNegative() {
        val r = RateMeter()
        r.sample(5_000, atMs = 0)
        assertEquals(0.0, r.sample(100, atMs = 1_000))
        assertEquals(100.0, r.sample(200, atMs = 2_000))
    }

    @Test
    fun twoSamplesAtTheSameInstantKeepTheLastRate() {
        val r = RateMeter()
        r.sample(0, atMs = 0)
        assertEquals(1_000.0, r.sample(1_000, atMs = 1_000))
        assertEquals(1_000.0, r.sample(9_999, atMs = 1_000))
    }
}

class UsageTotalsTest {
    @Test
    fun theSessionCountsFromItsStartAndAllTimeAddsEverySession() {
        val u = UsageTotals(MapStore())
        u.startSession(up = 1_000, down = 5_000)
        u.update(up = 1_300, down = 5_900)
        assertEquals(Totals(300, 900), u.session)
        assertEquals(Totals(300, 900), u.allTime)

        u.startSession(up = 9_000, down = 20_000) // a new join: the session restarts, all time keeps going
        assertEquals(Totals(0, 0), u.session)
        u.update(up = 9_100, down = 20_050)
        assertEquals(Totals(100, 50), u.session)
        assertEquals(Totals(400, 950), u.allTime)
    }

    @Test
    fun allTimeSurvivesARestartOfTheApp() {
        val store = MapStore()
        UsageTotals(store).apply { startSession(0, 0); update(10, 20) }
        assertEquals(Totals(10, 20), UsageTotals(store).allTime)
    }

    @Test
    fun resettingClearsAllTimeButNotTheSessionInProgress() {
        val u = UsageTotals(MapStore())
        u.startSession(0, 0)
        u.update(50, 60)
        u.resetAllTime()
        assertEquals(Totals(0, 0), u.allTime)
        assertEquals(Totals(50, 60), u.session)
        u.update(70, 80)
        assertEquals(Totals(20, 20), u.allTime) // only what came after the reset
    }

    @Test
    fun anUnsupportedOrBackwardsCounterAddsNothing() {
        val u = UsageTotals(MapStore())
        u.startSession(up = -1, down = -1) // TrafficStats says "unsupported" with -1
        u.update(up = -1, down = -1)
        assertEquals(Totals(0, 0), u.allTime)
        u.startSession(up = 1_000, down = 1_000)
        u.update(up = 10, down = 10) // the device counter restarted (a reboot)
        assertEquals(Totals(0, 0), u.session)
        u.update(up = 40, down = 30)
        assertEquals(Totals(30, 20), u.session)
    }

    @Test
    fun garbageInTheStoreIsIgnored() {
        val store = MapStore().apply { put("net_all_up", "lots"); put("net_all_down", "-5") }
        assertEquals(Totals(0, 0), UsageTotals(store).allTime)
    }
}
