import asyncio, base64, httpx, time

MODELS = [
    '[premium]gemini-2.5-flash',
    '[官]gemini-2.5-flash-image',
    '[满血C]gemini-2.5-flash',
]
KEY = 'sk-REDACTED'

async def test(model, label):
    async with httpx.AsyncClient(timeout=30) as c:
        with open('../496-2.jpg', 'rb') as f:
            img_b64 = base64.b64encode(f.read()).decode()

        # Test 1: simple text
        t0 = time.perf_counter()
        r = await c.post('https://api.gemai.cc/v1/chat/completions',
            headers={'Authorization': f'Bearer {KEY}', 'Content-Type': 'application/json'},
            json={'model': model, 'messages': [{'role':'user','content': 'hi'}], 'max_tokens': 5})
        t_text = time.perf_counter() - t0
        text_ok = r.status_code == 200

        # Test 2: image recognition
        t0 = time.perf_counter()
        r2 = await c.post('https://api.gemai.cc/v1/chat/completions',
            headers={'Authorization': f'Bearer {KEY}', 'Content-Type': 'application/json'},
            json={'model': model, 'messages': [{'role':'user','content': [
                {'type':'text','text':'What text do you see? Reply in one short sentence.'},
                {'type':'image_url','image_url':{'url': f'data:image/jpeg;base64,{img_b64}'}}
            ]}], 'max_tokens': 80})
        t_img = time.perf_counter() - t0
        img_ok = r2.status_code == 200
        img_text = r2.json()['choices'][0]['message']['content'][:120] if img_ok else r2.text[:100]

    print(f'[{t_text:.1f}s text] [{t_img:.1f}s img] {label}')
    print(f'   text: {"OK" if text_ok else "FAIL "+str(r.status_code)}')
    print(f'   image: {"OK" if img_ok else "FAIL "+str(r2.status_code)}')
    if img_ok:
        print(f'   result: {img_text}')
    print()

async def main():
    for m in MODELS:
        await test(m, m)

asyncio.run(main())
