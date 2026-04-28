"""Real end-to-end procurement order creation from image."""
import asyncio, json, os, sys, time, base64, io
from pathlib import Path
_AGENT_DIR = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(_AGENT_DIR))
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8', errors='replace')

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
from app.models import ChatRequest, AttachmentInput
from app.node_bridge import NodeToolBridge
from app.rag import RagEngine, EmbeddingClient
from app.memory import EpisodicMemoryStore
from app.orchestration import run_chat

# Full tool catalog matching actual server tools
_all_tools = [
    {'type':'function','function':{'name':'get_master_data_overview','description':'Get master data overview (suppliers, customers, products)','parameters':{'type':'object','properties':{'scope':{'type':'string','enum':['suppliers','customers','products','all']}}}},'metadata':{'access_mode':'read'}},
    {'type':'function','function':{'name':'query_inventory_item','description':'Query inventory by SKU or keyword','parameters':{'type':'object','properties':{'sku':{'type':'string'},'keyword':{'type':'string'}}}},'metadata':{'access_mode':'read'}},
    {'type':'function','function':{'name':'get_procurement_detail','description':'Get procurement order detail by ID','parameters':{'type':'object','required':['procurementId'],'properties':{'procurementId':{'type':'string'}}}},'metadata':{'access_mode':'read'}},
    {'type':'function','function':{'name':'create_supplier_profile','description':'Create supplier profile (approval required)','parameters':{'type':'object','required':['supplierName'],'properties':{'supplierName':{'type':'string'},'contactName':{'type':'string'},'phone':{'type':'string'}}}},'metadata':{'access_mode':'write'}},
    {'type':'function','function':{'name':'create_product_master_data','description':'Create product master data (approval required)','parameters':{'type':'object','required':['sku','name','preferredSupplierName'],'properties':{'sku':{'type':'string'},'name':{'type':'string'},'category':{'type':'string'},'unit':{'type':'string'},'costPrice':{'type':'number'},'salePrice':{'type':'number'},'preferredSupplierName':{'type':'string'}}}},'metadata':{'access_mode':'write'}},
    {'type':'function','function':{'name':'create_procurement_order','description':'Create procurement order with line items (approval required). Supports inline new products via productName/quantity/unitCost fields.','parameters':{'type':'object','required':['supplierName','expectedDate','items'],'properties':{'supplierName':{'type':'string'},'expectedDate':{'type':'string'},'items':{'type':'array','items':{'type':'object','properties':{'productName':{'type':'string'},'sku':{'type':'string'},'quantity':{'type':'integer'},'unitCost':{'type':'number'},'unit':{'type':'string'}}}}, 'remark':{'type':'string'}}}},'metadata':{'access_mode':'write'}},
]

async def _post(path, body):
    await asyncio.sleep(0.03)
    if path == '/tools/schema':
        return {'tools': _all_tools}
    if path == '/skills/match':
        return {'matchedSkills':[],'context':'','availableSkillCount':0}
    if path == '/document/context':
        return {'context':''}
    if path == '/memory/profile':
        return {'result':{'profile':{},'records':[],'updatedAt':'','updatedBy':''}}
    if path == '/tools/execute':
        tn = body.get('toolName','')
        args = json.loads(body.get('rawArguments','{}'))
        if tn == 'get_master_data_overview':
            return {'execution':{'toolCall':{'name':tn,'status':'completed','summary':'Found 0 suppliers, 0 customers'},'result':{'ok':True,'code':'ok','summary':'No matching records found','context':json.dumps({'suppliers':[],'customers':[],'products':[]})}}}
        if tn == 'query_inventory_item':
            return {'execution':{'toolCall':{'name':tn,'status':'completed','summary':'0 inventory items'},'result':{'ok':True,'code':'ok','summary':'No inventory found','context':json.dumps({'items':[]})}}}
        if tn == 'create_supplier_profile':
            return {'execution':{'toolCall':{'name':tn,'status':'awaiting_confirmation','summary':'Pending: create supplier '+str(args.get('supplierName',''))},'result':{'ok':True,'code':'pending_confirmation','summary':'Supplier profile pending approval','pendingAction':{'id':'sup-001','type':'supplier_profile','name':'新建供应商 '+str(args.get('supplierName','')),'status':'pending','summary':'待确认：创建供应商档案'}}}}
        if tn == 'create_product_master_data':
            return {'execution':{'toolCall':{'name':tn,'status':'awaiting_confirmation','summary':'Pending: product '+str(args.get('name',''))},'result':{'ok':True,'code':'pending_confirmation','summary':'Product pending approval','pendingAction':{'id':'prod-001','type':'product_master_data','name':'新建商品 '+str(args.get('name','')),'status':'pending','summary':'待确认：创建商品档案'}}}}
        if tn == 'create_procurement_order':
            items = args.get('items',[])
            total = sum((it.get('unitCost',0) or 0) * (it.get('quantity',0) or 0) for it in items)
            return {'execution':{'toolCall':{'name':tn,'status':'awaiting_confirmation','summary':f'{len(items)} items, total {total:.2f}'},'result':{'ok':True,'code':'pending_confirmation','summary':'采购单草稿已创建','pendingAction':{'id':'po-001','type':'procurement_order','name':'采购单草稿','status':'pending','summary':f'{len(items)}项商品 合计{total:.2f}元'}}}}
        return {'execution':{'toolCall':{'name':tn,'status':'disabled','summary':'Unknown tool'}}}
    if path == '/memory/capture':
        return {'result':{'captured':True,'mode':'python'}}
    return {}

async def main():
    config = AgentConfig()
    nb = NodeToolBridge(config)
    nb._post = _post
    emb = EmbeddingClient(config)
    epi = EpisodicMemoryStore(config)
    rag = RagEngine(config, emb, epi)

    with open('../496-2.jpg', 'rb') as f:
        img_b64 = base64.b64encode(f.read()).decode()

    # ===== TURN 1 =====
    req1 = ChatRequest(
        prompt='添加采购单',
        token='t', tenantId='default', userId='u1', username='test', conversationId='real-test',
        roles=['admin'], permissions=['procurement:write','sales:write','settings.master-data','inventory.view'],
        attachments=[AttachmentInput(fileName='496-2.jpg', kind='image', mimeType='image/jpeg', imageDataUrl='data:image/jpeg;base64,' + img_b64)]
    )

    print('=' * 60)
    print('TURN 1: Upload image, no hints about document type')
    print('=' * 60)
    t0 = time.perf_counter()
    r1 = await run_chat(req1, config=config, node_bridge=nb, rag=rag)
    t1 = time.perf_counter() - t0

    print(f'Time: {t1:.1f}s')
    print(f'Reply: {(r1.reply or "")[:300]}')
    print(f'Tools called: {[tc.name for tc in r1.toolCalls]}')
    print(f'Interruption: {r1.interruption is not None}')
    has_conv = bool(r1.conversationMessages)
    print(f'conversationMessages: {len(r1.conversationMessages) if has_conv else 0}')
    if r1.interruption:
        print(f'  Title: {r1.interruption.title}')
        for o in r1.interruption.options:
            print(f'  [{o.id}] {o.label}')

    if not r1.interruption or not r1.conversationMessages:
        print('\nSKIP TURN 2: no interruption or messages')
        return

    # ===== TURN 2: Click "新建供应商与商品并导入" =====
    # Pick the option that creates new supplier + products
    opt = next((o for o in r1.interruption.options if '新建' in (o.label or '')), r1.interruption.options[0])

    req2 = ChatRequest(
        prompt=opt.prompt,
        token='t', tenantId='default', userId='u1', username='test', conversationId='real-test',
        roles=['admin'], permissions=['procurement:write','sales:write','settings.master-data','inventory.view'],
        resume={'interruptionId': r1.interruption.id, 'optionId': opt.id, 'prompt': opt.prompt},
        conversationMessages=r1.conversationMessages,
    )

    print('')
    print('=' * 60)
    print(f'TURN 2: Click "{opt.label}"')
    print(f'Resume with {len(req2.conversationMessages)} saved messages')
    print('=' * 60)
    t0 = time.perf_counter()
    r2 = await run_chat(req2, config=config, node_bridge=nb, rag=rag)
    t2 = time.perf_counter() - t0

    print(f'Time: {t2:.1f}s')
    print(f'Reply: {(r2.reply or "")[:400]}')
    print(f'Tools called: {[tc.name for tc in r2.toolCalls]}')
    print(f'Pending action: {r2.pendingAction is not None}')
    if r2.pendingAction:
        print(f'  Name: {r2.pendingAction.get("name")}')
    if r2.interruption:
        print(f'New interruption: {r2.interruption.title}')

    print('')
    print('=' * 60)
    print('SUMMARY')
    print('=' * 60)
    print(f'Turn 1: {t1:.1f}s (image recognition + interruption)')
    print(f'Turn 2: {t2:.1f}s (resume with context)')
    print(f'Total: {t1+t2:.1f}s')

if __name__ == '__main__':
    asyncio.run(main())
