"""Measure time at each pipeline stage with real API calls."""
import asyncio, json, os, sys, time, base64
from pathlib import Path
_AGENT_DIR = Path(__file__).resolve().parent.parent
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

timings = []
_llm_calls = [0]

async def _post(path, body):
    t0 = time.perf_counter()
    await asyncio.sleep(0.03)
    name = path.rsplit('/', 1)[-1]
    if path == '/tools/schema':
        result = {'tools': [
            {'type':'function','function':{'name':'get_master_data_overview','description':'Get master data','parameters':{'type':'object','properties':{'scope':{'type':'string'}}}},'metadata':{'access_mode':'read'}},
            {'type':'function','function':{'name':'create_procurement_order','description':'Create procurement order','parameters':{'type':'object','properties':{'supplierName':{'type':'string'},'expectedDate':{'type':'string'},'items':{'type':'array'},'remark':{'type':'string'}}}},'metadata':{'access_mode':'write'}},
            {'type':'function','function':{'name':'create_customer_profile','description':'Create customer','parameters':{'type':'object','properties':{'customerName':{'type':'string'}}}},'metadata':{'access_mode':'write'}},
        ]}
    elif path == '/skills/match':
        result = {'matchedSkills':[],'context':'','availableSkillCount':0}
    elif path == '/document/context':
        result = {'context':''}
    elif path == '/memory/profile':
        result = {'result':{'profile':{},'records':[],'updatedAt':'','updatedBy':''}}
    elif path == '/tools/execute':
        tn = body.get('toolName','')
        result = {'execution':{'toolCall':{'name':tn,'status':'completed' if tn != 'create_customer_profile' else 'awaiting_confirmation','summary':'Done'},'result':{'ok':True,'code':'ok','context':json.dumps({'suppliers':[{'name':'佛山好的科技有限公司','status':'active'}],'customers':[]})}}}
        if tn == 'create_customer_profile':
            result['execution']['result']['pendingAction'] = {'id':'c1','type':'customer','name':'新客户','status':'pending'}
        name = 'tool:' + tn
    elif path == '/memory/capture':
        result = {'result':{'captured':True}}
    else:
        result = {}
    t = time.perf_counter() - t0
    timings.append(('bridge:' + name, t))
    return result


async def timed_model_requester(config, messages, *, tools=None, tool_choice=None, role='large'):
    """Wrap real model requester with timing."""
    from app.model_client import request_model as real_requester
    _llm_calls[0] += 1
    call_num = _llm_calls[0]
    t0 = time.perf_counter()
    result = await real_requester(config, messages, tools=tools, tool_choice=tool_choice, role=role)
    t = time.perf_counter() - t0
    model = config.resolve_model_profile(role)['model']
    label = f'llm:{role}'
    if tool_choice == 'none':
        label += ':no_tools'
    if tools:
        label += f':tools={len(tools)}'
    timings.append((label, t))
    print(f'  LLM #{call_num} [{role}] {t:.1f}s (tool_choice={tool_choice}, tools={len(tools or [])})')
    return result


async def main():
    config = AgentConfig()
    nb = NodeToolBridge(config)
    nb._post = _post
    emb = EmbeddingClient(config)
    epi = EpisodicMemoryStore(config)
    rag = RagEngine(config, emb, epi)

    with open('../496-2.jpg', 'rb') as f:
        img_b64 = base64.b64encode(f.read()).decode()

    req = ChatRequest(
        prompt='请帮我处理这张单据',
        token='t', tenantId='default', userId='u1', username='test', conversationId='timing2',
        roles=['admin'], permissions=['procurement:write','sales:write'],
        attachments=[AttachmentInput(fileName='496-2.jpg', kind='image', mimeType='image/jpeg', imageDataUrl='data:image/jpeg;base64,' + img_b64)]
    )

    print('Running pipeline with timing...')
    print('')
    t0 = time.perf_counter()
    result = await run_chat(req, config=config, node_bridge=nb, rag=rag, model_requester=timed_model_requester)
    total = time.perf_counter() - t0

    print('')
    print('=' * 60)
    print('TIMING BREAKDOWN (' + str(round(total, 1)) + 's total)')
    print('=' * 60)

    # Group by category
    llm_total = sum(t for label, t in timings if label.startswith('llm:'))
    bridge_total = sum(t for label, t in timings if label.startswith('bridge:'))
    overhead = total - llm_total - bridge_total

    print('')
    print('--- LLM Calls (' + str(_llm_calls[0]) + ' calls, ' + str(round(llm_total, 1)) + 's) ---')
    for label, t in timings:
        if label.startswith('llm:'):
            bar = '#' * int(t * 2)
            print('  ' + label + ': ' + str(round(t, 1)) + 's ' + bar)

    print('')
    print('--- Node Bridge (' + str(round(bridge_total, 1)) + 's) ---')
    for label, t in timings:
        if label.startswith('bridge:'):
            print('  ' + label + ': ' + str(round(t, 2)) + 's')

    print('')
    print('--- Summary ---')
    print('  LLM calls:     ' + str(round(llm_total, 1)) + 's (' + str(round(llm_total/total*100)) + '%)')
    print('  Node bridge:   ' + str(round(bridge_total, 1)) + 's (' + str(round(bridge_total/total*100)) + '%)')
    print('  Python overhead: ' + str(round(overhead, 1)) + 's (' + str(round(overhead/total*100)) + '%)')
    print('  TOTAL:         ' + str(round(total, 1)) + 's')

if __name__ == '__main__':
    asyncio.run(main())
