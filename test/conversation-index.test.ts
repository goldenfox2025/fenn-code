import { describe, expect, it } from 'vitest'
import { conversationIndexEntries, conversationIndexRows, conversationNodeTone, conversationNodeWeight, visibleConversationIds } from '../src/shared/conversationIndex'

describe('compact conversation index', () => {
  it('forms a symmetric ridge across neighbouring ticks rather than enlarging one isolated tick', () => {
    const weights=[0,10,20,30,40,50].map(conversationNodeWeight)
    expect(weights[0]).toBe(1);expect(weights.at(-1)).toBe(0)
    expect(weights.slice(1).every((value,index)=>value<weights[index])).toBe(true)
    expect(conversationNodeWeight(-20)).toBe(conversationNodeWeight(20))
    expect(conversationNodeWeight(10)).toBeGreaterThan(.8)
  })
  it('keeps nodes user-only while previewing the reply from the same turn', () => {
    const entries = conversationIndexEntries([{id:'intro',role:'assistant',text:'hello'}, {id:'u',role:'user',text:'question'}, {id:'a',role:'assistant',text:'answer'}, {id:'b',role:'assistant',text:'continued'}, {id:'v',role:'user',text:'unanswered'}])
    expect(entries).toEqual([{id:'u',prompt:'question',reply:'answer\ncontinued'}, {id:'v',prompt:'unanswered',reply:''}])
  })
  it('reserves full ink for the peak while keeping long neighbours gray', () => {
    const tones = [0, 10, 20, 30, 40, 50].map(conversationNodeTone)
    expect(tones[0]).toBe(1)
    expect(tones.slice(1).every(tone => tone >= 0 && tone < .25)).toBe(true)
    expect(tones.slice(1).every((tone, index) => tone < tones[index])).toBe(true)
    expect(conversationNodeTone(-20)).toBe(conversationNodeTone(20))
    expect(conversationNodeWeight(10)).toBeGreaterThan(.8)
  })
  it('marks the entire reading viewport, including partially visible message ends', () => {
    const points = [{id:'a',offset:0},{id:'b',offset:100},{id:'c',offset:300},{id:'d',offset:600}]
    expect(visibleConversationIds(points,150,500,1000)).toEqual(['b','c','d'])
    expect(visibleConversationIds(points,0,100,1000)).toEqual(['a'])
  })
  it('does not spread a short conversation over the full transcript height', () => {
    const rows = conversationIndexRows(['a', 'b', 'c', 'd'], 700)
    expect(rows.map(row => row.top)).toEqual([330, 340, 350, 360])
    expect(rows.at(-1)!.top - rows[0].top).toBe(30)
  })
  it('groups only when needed, preserves every message exactly once and stays bounded', () => {
    const ids = Array.from({ length: 101 }, (_, i) => String(i))
    const rows = conversationIndexRows(ids, 217)
    expect(rows).toHaveLength(21)
    expect(rows.flatMap(row => row.ids)).toEqual(ids)
    expect(rows.every(row => row.ids.length > 0 && row.top >= 0 && row.top + 10 <= 217)).toBe(true)
  })
  it('does not invent nodes for missing messages', () => {
    expect(conversationIndexRows([], 700)).toEqual([])
    expect(conversationIndexRows(['only'], 100)).toEqual([{ ids: ['only'], top: 45 }])
  })
})
