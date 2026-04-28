"""Test streaming progress callbacks in run_chat."""
import asyncio, json, os, sys
from pathlib import Path
_AGENT_DIR = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(_AGENT_DIR))
os.environ['AI_SMALL_PROVIDER'] = 'openai'
os.environ['AI_SMALL_BASE_URL'] = 'https://api.gemai.cc/v1'
os.environ['AI_SMALL_API_KEY'] = 'sk-REDACTED'
os.environ['AI_SMALL_MODEL'] = '[官]gemini-2.5-flash-image'
os.environ['DEEPSEEK_API_KEY'] = 'sk-REDACTED'
os.environ['AI_PROVIDER'] = 'deepseek'
os.environ['AI_LARGE_MODEL'] = 'deepseek-v4-flash'
os.environ['AI_MODEL_IO_CONSOLE_LOG'] = 'false'
os.environ['RAG_LANCEDB_ENABLED'] = 'false'
from app.common import AgentConfig
from app.models import ChatRequest
from app.node_bridge import NodeToolBridge
from app.rag import RagEngine, EmbeddingClient
from app.memory import EpisodicMemoryStore
from app.orchestration import run_chat

async def _post(path, body):
    await asyncio.sleep(0.03)
    if path == '/tools/schema':
        return {'tools': [{'type':'function','function':{'name':'get_master_data_overview','description':'x'},'metadata':{'access_mode':'read'}}]}
    if path == '/skills/match':
        return {'matchedSkills':[],'context':'','availableSkillCount':0}
    if path == '/document/context':
        return {'context':''}
    if path == '/memory/profile':
        return {'result':{'profile':{},'records':[]}}
    if path == '/tools/execute':
        return {'execution':{'toolCall':{'name':body.get('toolName',''),'status':'completed','summary':'ok'},'result':{'ok':True}}}
    if path == '/memory/capture':
        return {'result':{'captured':True}}
    return {}

async def main():
    config = AgentConfig()
    nb = NodeToolBridge(config)
    nb._post = _post
    emb = EmbeddingClient(config)
    epi = EpisodicMemoryStore(config)
    rag = RagEngine(config, emb, epi)

    progress = []
    async def on_progress(kind, msg):
        progress.append((kind, msg))
        print('  PROGRESS: [' + kind + '] ' + msg)

    req = ChatRequest(
        prompt='查询当前库存状况',
        token='t', tenantId='d', userId='u', username='test', conversationId='stream-test',
        roles=['admin'], permissions=['inventory:read'],
    )

    print('Starting stream test...')
    result = await run_chat(req, config=config, node_bridge=nb, rag=rag, on_progress=on_progress)
    print('Done. Progress events: ' + str(len(progress)))
    for kind, msg in progress:
        print('  [' + kind + '] ' + msg)
    print('Reply: ' + (result.reply or '')[:200])

if __name__ == '__main__':
    asyncio.run(main())
