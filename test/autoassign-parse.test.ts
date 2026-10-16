import { describe, expect, it } from 'vitest'
import { matchProject, parseAnswer } from '../src/main/core/AutoAssigner'

const projects = [
  { id: 'a1b2c3d4-0000-4000-8000-000000000001', name: '园艺' },
  { id: 'e5f6a7b8-0000-4000-8000-000000000002', name: 'Finance' }
]
const pick = (answer: string) => matchProject(parseAnswer(answer).project, projects)?.name

describe('auto-assign answers', () => {
  it('accepts the id, an id prefix, the name, or a quoted name', () => {
    expect(pick('{"title":"番茄","project":"a1b2c3d4-0000-4000-8000-000000000001"}')).toBe('园艺')
    expect(pick('{"title":"番茄","project":"a1b2c3d4"}')).toBe('园艺')
    expect(pick('{"title":"番茄","project":"园艺"}')).toBe('园艺')
    expect(pick('{"title":"报税","project":"「finance」"}')).toBe('Finance')
    expect(pick('{"title":"番茄","project":"园艺项目"}')).toBe('园艺')
  })

  it('finds the JSON among explanation text, including braces in the prose', () => {
    expect(pick('好的，我的判断是 {"title":"番茄","project":"园艺"}。理由：{涉及种植}')).toBe('园艺')
    expect(pick('分析 {这是一段说明}\n```json\n{"title": "报税", "project": "Finance"}\n```')).toBe('Finance')
    expect(pick('project: 园艺')).toBe('园艺')
  })

  it('assigns nothing for none or anything ambiguous', () => {
    expect(pick('{"title":"你好","project":"none"}')).toBeUndefined()
    expect(pick('{"title":"你好","project":"无"}')).toBeUndefined()
    expect(pick('{"title":"你好","project":"e"}')).toBeUndefined()
    expect(pick('随便聊聊')).toBeUndefined()
  })
})
