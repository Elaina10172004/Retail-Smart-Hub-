"""Test two-turn conversation with conversationMessages restore."""
import asyncio, json, os, sys, time, base64
from pathlib import Path

_AGENT_DIR = Path(__file__).resolve().parent.parent
if str(_AGENT_DIR) not in sys.path:
    sys.path.insert(0, str(_AGENT_DIR))
if hasattr(sys.stdout, 'reconfigure'):
    sys.stdout.reconfigure(encoding='utf-8', errors='replace')

os.environ.setdefault('AI_SMALL_PROVIDER', 'gemini')
os.environ.setdefault('AI_SMALL_MODEL', 'gemini-2.5-flash')
os.environ.setdefault('AI_PROVIDER', 'gemini')
os.environ.setdefault('AI_LARGE_PROVIDER', 'gemini')
os.environ.setdefault('AI_LARGE_MODEL', 'gemini-2.5-flash')
os.environ.setdefault('AI_MODEL_IO_CONSOLE_LOG', 'false')
os.environ.setdefault('RAG_LANCEDB_ENABLED', 'false')
from app.common import AgentConfig
from app.models import ChatRequest, AttachmentInput
from app.node_bridge import NodeToolBridge
from app.rag import RagEngine, EmbeddingClient
from app.memory import EpisodicMemoryStore
from app.orchestration import run_chat


async def post(path, body):
    await asyncio.sleep(0.03)
    if path == '/tools/schema':
        return {'tools': [
            {'type':'function','function':{'name':'get_master_data_overview','description':'Get master data','parameters':{'type':'object','properties':{'scope':{'type':'string'}}}},'metadata':{'access_mode':'read'}},
            {'type':'function','function':{'name':'create_procurement_order','description':'Create procurement order','parameters':{'type':'object','properties':{'supplierName':{'type':'string'},'expectedDate':{'type':'string'},'items':{'type':'array'},'remark':{'type':'string'}}}},'metadata':{'access_mode':'write'}},
            {'type':'function','function':{'name':'create_customer_profile','description':'Create customer profile','parameters':{'type':'object','properties':{'customerName':{'type':'string'}}}},'metadata':{'access_mode':'write'}},
        ]}
    elif path == '/skills/match':
        return {'matchedSkills':[],'context':'','availableSkillCount':0}
    elif path == '/document/context':
        return {'context':''}
    elif path == '/memory/profile':
        return {'result':{'profile':{},'records':[],'updatedAt':'','updatedBy':''}}
    elif path == '/tools/execute':
        tn = body.get('toolName','')
        if tn == 'get_master_data_overview':
            return {'execution':{'toolCall':{'name':tn,'status':'completed','summary':'Found'},'result':{'ok':True,'code':'ok','summary':'Active','context':json.dumps({'suppliers':[{'name':'佛山好的科技有限公司','status':'active'}],'customers':[]})}}}
        if tn == 'create_customer_profile':
            return {'execution':{'toolCall':{'name':tn,'status':'awaiting_confirmation','summary':'Created'},'result':{'ok':True,'code':'pending_confirmation','summary':'Done','pendingAction':{'id':'cust-001','type':'customer_profile','name':'新建客户','status':'pending','summary':'新客户'}}}}
        if tn == 'create_procurement_order':
            return {'execution':{'toolCall':{'name':tn,'status':'awaiting_confirmation','summary':'Created'},'result':{'ok':True,'code':'pending_confirmation','summary':'Done','pendingAction':{'id':'po-001','type':'procurement_order','name':'采购单','status':'pending','summary':'已创建'}}}}
        return {'execution':{'toolCall':{'name':tn,'status':'disabled'}}}
    elif path == '/memory/capture':
        return {'result':{'captured':True,'mode':'python'}}
    return {}


async def main():
    config = AgentConfig()
    nb = NodeToolBridge(config)
    nb._post = post
    emb = EmbeddingClient(config)
    epi = EpisodicMemoryStore(config)
    rag = RagEngine(config, emb, epi)

    with open('../496-2.jpg', 'rb') as f:
        img_b64 = base64.b64encode(f.read()).decode()

    # TURN 1
    req1 = ChatRequest(
        prompt='请帮我处理这张单据',
        token='t', tenantId='default', userId='u1', username='tester', conversationId='e2e',
        roles=['admin'], permissions=['procurement:write','sales:write','customers:write'],
        attachments=[AttachmentInput(fileName='496-2.jpg', kind='image', mimeType='image/jpeg', imageDataUrl='data:image/jpeg;base64,' + img_b64)]
    )

    print('=== TURN 1 ===')
    t0 = time.perf_counter()
    r1 = await run_chat(req1, config=config, node_bridge=nb, rag=rag)
    t1 = time.perf_counter() - t0
    print('Time: ' + str(round(t1, 1)) + 's')
    print('Reply: ' + (r1.reply or '')[:250])
    print('Interruption: ' + str(r1.interruption is not None))
    has_msgs = bool(r1.conversationMessages)
    print('Has conversationMessages: ' + str(has_msgs))
    if has_msgs:
        print('  Count: ' + str(len(r1.conversationMessages)))

    if not r1.interruption or not r1.conversationMessages:
        print('SKIP turn 2')
        return

    # TURN 2
    opt = r1.interruption.options[0]
    req2 = ChatRequest(
        prompt=opt.prompt,
        token='t', tenantId='default', userId='u1', username='tester', conversationId='e2e',
        roles=['admin'], permissions=['procurement:write','sales:write','customers:write'],
        resume={'interruptionId': r1.interruption.id, 'optionId': opt.id, 'prompt': opt.prompt},
        conversationMessages=r1.conversationMessages,
    )

    print('')
    print('=== TURN 2: Resume [' + opt.label + '] ===')
    print('Using ' + str(len(req2.conversationMessages)) + ' saved messages')
    t0 = time.perf_counter()
    r2 = await run_chat(req2, config=config, node_bridge=nb, rag=rag)
    t2 = time.perf_counter() - t0
    print('Time: ' + str(round(t2, 1)) + 's')
    print('Reply: ' + (r2.reply or '')[:300])
    print('Tool calls: ' + str(len(r2.toolCalls)))
    for tc in r2.toolCalls:
        print('  [' + tc.status + '] ' + tc.name)
    if r2.pendingAction:
        print('Pending: ' + str(r2.pendingAction.get('name')))
    if r2.interruption:
        print('New interruption: ' + r2.interruption.title)

    print('')
    print('=== SUMMARY ===')
    print('Turn 1: ' + str(round(t1,1)) + 's (image + interruption)')
    print('Turn 2: ' + str(round(t2,1)) + 's (resume with ' + str(len(req2.conversationMessages)) + ' msgs)')
    print('Total: ' + str(round(t1+t2,1)) + 's')


if __name__ == '__main__':
    asyncio.run(main())
