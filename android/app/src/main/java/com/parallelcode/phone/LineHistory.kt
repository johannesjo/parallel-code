package com.parallelcode.phone

/**
 * Scrolled-off terminal lines, oldest first, capped at [capacity].
 *
 * Every output frame renders a snapshot of the whole history, so it is stored in fixed blocks that
 * never change once full: a [snapshot] copies only the block list and the open block, a few
 * hundred references, rather than every line.
 */
class LineHistory<T>(private val capacity: Int, private val blockSize: Int = 256) {
    private val blocks = ArrayDeque<List<T>>()
    private var open = ArrayList<T>(blockSize)

    /** Lines of the first block already dropped by the cap. */
    private var dropped = 0

    var size = 0
        private set

    fun add(line: T) {
        open.add(line)
        if (open.size == blockSize) {
            blocks.addLast(open)
            open = ArrayList(blockSize)
        }
        size++
        if (size > capacity) {
            dropped++
            size--
            if (blocks.isNotEmpty() && dropped == blockSize) {
                blocks.removeFirst()
                dropped = 0
            } else if (blocks.isEmpty()) {
                // Only with a capacity below one block: drop from the open block itself.
                open.removeAt(0)
                dropped = 0
            }
        }
    }

    fun clear() {
        blocks.clear()
        open = ArrayList(blockSize)
        dropped = 0
        size = 0
    }

    /** The lines as they are now; later additions do not show in it. */
    fun snapshot(): List<T> {
        val full = blocks.toList()
        val tail = open.toList()
        val start = dropped
        val count = size
        val block = blockSize
        return object : AbstractList<T>() {
            override val size = count

            override fun get(index: Int): T {
                if (index !in 0 until count) throw IndexOutOfBoundsException("$index of $count")
                val i = index + start
                val b = i / block
                return if (b < full.size) full[b][i % block] else tail[i - full.size * block]
            }
        }
    }
}
