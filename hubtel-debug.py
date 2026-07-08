import base64
import json
from pathlib import Path
import urllib.request
import urllib.error

path = Path('.env.local') if Path('.env.local').exists() else Path('.env')
if not path.exists():
    raise SystemExit('No .env or .env.local found')

env = {}
for line in path.read_text().splitlines():
    line = line.strip()
    if not line or line.startswith('#'):
        continue
    if '=' not in line:
        continue
    key, val = line.split('=', 1)
    env[key] = val

headers = {
    'Content-Type': 'application/json',
    'Authorization': 'Basic ' + base64.b64encode(
        f"{env.get('HUBTEL_CLIENT_ID','')}:{env.get('HUBTEL_CLIENT_SECRET','')}".encode('utf-8')
    ).decode('utf-8')
}
payload = json.dumps({
    'totalAmount': 100,
    'description': 'Test payment',
    'merchantAccountNumber': env.get('HUBTEL_MERCHANT_ACCOUNT_NUMBER', ''),
    'callbackUrl': env.get('HUBTEL_CALLBACK_URL', ''),
    'returnUrl': env.get('HUBTEL_RETURN_URL', ''),
    'cancellationUrl': env.get('HUBTEL_CANCELLATION_URL', ''),
    'clientReference': 'test-node-002'
}).encode('utf-8')

urls = [
    'https://payproxyapi.hubtel.com/items/initiate',
    'https://api.hubtel.com/items/v1/initiate',
    'https://api.hubtel.com/v1/items/initiate',
    'https://api.hubtel.com/v1/payments/initiate'
]

for url in urls:
    print('URL:', url)
    req = urllib.request.Request(url, data=payload, headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            print('status', r.status)
            print('headers:', dict(r.getheaders()))
            body = r.read()
            print('body:', body.decode('utf-8', errors='replace'))
    except urllib.error.HTTPError as e:
        print('status', e.code)
        print('headers:', dict(e.headers))
        body = e.read()
        print('body:', body.decode('utf-8', errors='replace'))
    except Exception as e:
        print('error', repr(e))
    print('---')
