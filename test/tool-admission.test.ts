import {request} from 'node:http'
import {describe,it,expect} from 'vitest'
import {ToolServer,type ToolDef} from '../src/main/tools/ToolServer'

const body=JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'probe',arguments:{}}})
function delayed(url:string){
  let finish!:(value:{status:number;body:any})=>void
  const result=new Promise<{status:number;body:any}>(resolve=>finish=resolve)
  const req=request(url,{method:'POST',headers:{'content-type':'application/json','content-length':Buffer.byteLength(body)}},res=>{
    let text='';res.setEncoding('utf8');res.on('data',s=>text+=s);res.on('end',()=>finish({status:res.statusCode!,body:JSON.parse(text)}))
  })
  req.flushHeaders();return {req,result}
}

describe('host-tool request admission',()=>{
  it('revoking while a body is in flight prevents dispatch',async()=>{
    const server=new ToolServer();await server.start()
    let admitted!:()=>void,executed=0
    const accepted=new Promise<void>(r=>admitted=r)
    const endpoint=server.endpoint('conversation',()=>{admitted();return [{name:'probe',description:'probe',inputSchema:{type:'object'},run:async()=>{executed++;return 'unsafe'}}]})
    try{
      const call=delayed(endpoint.url);await accepted;server.revoke('conversation');call.req.end(body)
      const response=await call.result;expect(response.status).toBe(410);expect(executed).toBe(0)
    }finally{server.stop()}
  })
  it('a slow old caller cannot borrow a new task on the same endpoint',async()=>{
    const server=new ToolServer();await server.start()
    let current='run-1',admitted!:()=>void,executed=0
    const accepted=new Promise<void>(r=>admitted=r)
    const endpoint=server.endpoint('conversation',()=>{
      const captured=current;admitted()
      const tool:ToolDef={name:'probe',description:'probe',inputSchema:{type:'object'},run:async()=>{if(captured!==current)throw Error('task was replaced');executed++;return captured}}
      return [tool]
    })
    try{
      const call=delayed(endpoint.url);await accepted;current='run-2';call.req.end(body)
      const response=await call.result;expect(response.status).toBe(200);expect(response.body.result.isError).toBe(true);expect(executed).toBe(0)
    }finally{server.stop()}
  })
  it('rechecks revocation between batched operations',async()=>{
    const server=new ToolServer();await server.start();let executed=0
    const endpoint=server.endpoint('conversation',()=>[{name:'probe',description:'probe',inputSchema:{type:'object'},run:async()=>{executed++;server.revoke('conversation');return 'first'}}])
    try{
      const response=await fetch(endpoint.url,{method:'POST',body:JSON.stringify([JSON.parse(body),{...JSON.parse(body),id:2}])})
      expect(response.status).toBe(410);expect(executed).toBe(1)
    }finally{server.stop()}
  })
})
