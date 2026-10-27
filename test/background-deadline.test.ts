import { afterEach, describe, expect, it, vi } from 'vitest'
import { BackendManager } from '../src/main/backends/BackendManager'

afterEach(() => vi.useRealTimers())
function manager(backend: Record<string, unknown>) {
  const mgr = new BackendManager({plugins:[],settings:{get:()=>({}),set:()=>{}},resourcesDir:'.',nodeCommand:{command:process.execPath,env:{}},defaultCwd:'.',emit:()=>{}})
  vi.spyOn(mgr as never, 'get').mockReturnValue(backend as never)
  return mgr
}
describe('background task deadlines', () => {
  it('bounds session startup and discards a session which arrives after the deadline', async () => {
    vi.useFakeTimers()
    let opened!: (value: {sessionId:string}) => void
    const backend = {newSession:()=>new Promise(resolve=>{opened=resolve}),prompt:vi.fn(),closeSession:vi.fn().mockResolvedValue(undefined)}
    const work = manager(backend).ask('fixture','select evidence',{timeoutMs:100})
    const failed = expect(work).rejects.toThrow('整理超时')
    await vi.advanceTimersByTimeAsync(100); await failed
    opened({sessionId:'late'}); await vi.advanceTimersByTimeAsync(1)
    expect(backend.prompt).not.toHaveBeenCalled()
    expect(backend.closeSession).toHaveBeenCalledWith('late',{discard:true})
  })
  it('bounds model setup and never sends a prompt after timed-out setup eventually completes', async () => {
    vi.useFakeTimers()
    let configured!: () => void
    const backend = {newSession:vi.fn().mockResolvedValue({sessionId:'s'}),setModel:()=>new Promise<void>(resolve=>{configured=resolve}),prompt:vi.fn(),cancel:vi.fn().mockResolvedValue(undefined),closeSession:vi.fn().mockResolvedValue(undefined)}
    const work=manager(backend).ask('fixture','select evidence',{timeoutMs:100,modelId:'model'})
    const failed=expect(work).rejects.toThrow('整理超时')
    await vi.advanceTimersByTimeAsync(100);await failed
    configured();await vi.advanceTimersByTimeAsync(1)
    expect(backend.cancel).toHaveBeenCalledWith('s')
    expect(backend.closeSession).toHaveBeenCalledTimes(1)
    expect(backend.prompt).not.toHaveBeenCalled()
  })
})
