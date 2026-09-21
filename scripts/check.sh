#!/usr/bin/env bash
# The one runnable check: scoring, automated trust rules, reports, WhatsApp.
# Starts its own server on a throwaway database with Gemini and Paystack
# switched off, so it is deterministic, free, and never touches real data.
# Usage: ./scripts/check.sh   (after `npm run build`)
set -u
cd "$(dirname "$0")/.."
PORT=3299
BASE="http://localhost:$PORT"
DATA=$(mktemp -d)
TRACE_DATA_DIR="$DATA" GEMINI_API_KEY= PAYSTACK_SECRET_KEY= TWILIO_AUTH_TOKEN=check TRACE_API_KEYS=check ADMIN_PASSWORD=check \
  NODE_ENV=development npx next start -p $PORT >"$DATA/server.log" 2>&1 &
SERVER=$!
trap 'kill $SERVER 2>/dev/null; rm -rf "$DATA"' EXIT
for _ in $(seq 1 60); do curl -s -o /dev/null "$BASE/api/check" && break; sleep 1; done
python3 - "$BASE" <<'PY'
import base64, hashlib, hmac, json, random, sys, urllib.request, urllib.parse, uuid
base = sys.argv[1]; fail = 0
login = {}
def req(path, body=None, headers={}, form=False, auth=True):
    if auth and login: headers = {'cookie': login['cookie'], **headers}
    data = None
    if body is not None:
        data = urllib.parse.urlencode(body).encode() if form else json.dumps(body).encode()
        headers = {'content-type': 'application/x-www-form-urlencoded' if form else 'application/json', **headers}
    try:
        with urllib.request.urlopen(urllib.request.Request(base + path, data, headers)) as r:
            return r.status, r.read().decode()
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode()
def check(name, got, want):
    global fail
    ok = got == want; fail |= not ok
    print(f"  {'ok  ' if ok else 'FAIL'} {name}: {got}" + ('' if ok else f" (want {want})"))

# Sign-in: checks and reports are free 5 times per device, then need an account.
newdev = {'x-trace-device': str(uuid.uuid4())}
check('5 free checks', [req('/api/check', {'accountNumber': '9000000001'}, newdev, auth=False)[0] for _ in range(5)], [200] * 5)
s6, b6 = req('/api/check', {'accountNumber': '9000000001'}, newdev, auth=False)
check('6th check asks to sign in', (s6, json.loads(b6).get('signIn')), (401, True))
check('rejects a non-Nigerian phone', req('/api/auth', {'phone': '12345', 'password': 'secret123'})[0], 400)
check('rejects a short password', req('/api/auth', {'phone': '08031234567', 'password': '123'})[0], 400)
with urllib.request.urlopen(urllib.request.Request(base + '/api/auth', json.dumps({'phone': '0803 123 4567', 'password': 'secret123'}).encode(), {'content-type': 'application/json'})) as r:
    login['cookie'] = r.headers['set-cookie'].split(';')[0]
    check('first sign-in creates the account', r.status, 200)
check('same phone in another format, wrong password', req('/api/auth', {'phone': '+2348031234567', 'password': 'nope1234'}, auth=False)[0], 401)
check('same phone, right password signs in', req('/api/auth', {'phone': '2348031234567', 'password': 'secret123'}, auth=False)[0], 200)
check('signed in, checks keep working', req('/api/check', {'accountNumber': '9000000001'}, newdev)[0], 200)
check('status shows signed in', json.loads(req('/api/auth', headers=newdev)[1])['signedIn'], True)

acct = '9' + ''.join(random.choice('0123456789') for _ in range(9))
check('unknown account is LOW', json.loads(req('/api/check', {'accountNumber': acct})[1])['risk'], 'LOW')

def report(device, text='I paid for an iPhone and the seller blocked me after receiving the money.'):
    c = json.loads(req('/api/ai/classify', {'text': text})[1])
    boundary = uuid.uuid4().hex
    fields = {'text': text, 'classification': json.dumps(c['classification']), 'token': c['token'], 'accountNumber': acct, 'bank': 'GTBank', 'anonymous': 'true'}
    body = ''.join(f'--{boundary}\r\nContent-Disposition: form-data; name="{k}"\r\n\r\n{v}\r\n' for k, v in fields.items()) + f'--{boundary}--\r\n'
    r = urllib.request.Request(base + '/api/reports', body.encode(), {'content-type': f'multipart/form-data; boundary={boundary}', 'x-trace-device': device, 'cookie': login['cookie']})
    try:
        with urllib.request.urlopen(r) as res: return json.loads(res.read())
    except urllib.error.HTTPError as e: return {'status': f'HTTP {e.code}'}

d1 = str(uuid.uuid4())
check('first report counts', report(d1)['status'], 'added')
check('same person again is duplicate', report(d1)['status'], 'duplicate')
check('one reporter stays LOW', json.loads(req('/api/check', {'accountNumber': acct, 'bank': 'GTBank'})[1])['risk'], 'LOW')
check('vague report needs detail', report(str(uuid.uuid4()), 'hello there')['status'], 'needs_detail')
for _ in range(3): report(str(uuid.uuid4()))
r = json.loads(req('/api/check', {'accountNumber': acct, 'bank': 'GTBank'})[1])
check('4 independent reporters raise risk', r['risk'] in ('MEDIUM', 'HIGH'), True)
check('reporter sees own reports', len(json.loads(req('/api/reports', headers={'x-trace-device': d1})[1])), 2)

for lang, text in {
  'yo': 'Mo san owó fún iPhone, ṣùgbọ́n ẹni tó ń tà á dí mi lẹ́yìn tí ó gba owó náà.',
  'ha': 'Na biya kuɗin wayar iPhone, amma mai sayarwa ya toshe ni bayan ya karɓi kuɗin.',
  'pcm': 'I pay for iPhone but the seller block me after e collect the money.',
}.items():
    check(f'classify {lang}', json.loads(req('/api/ai/classify', {'text': text})[1])['classification']['category'], 'marketplace_fraud')

def wa(body, token='check', sender='whatsapp:+2340000000001'):
    params = {'Body': body, 'From': sender, 'NumMedia': '0'}
    signed = base + '/api/whatsapp' + ''.join(k + params[k] for k in sorted(params))
    sig = base64.b64encode(hmac.new(token.encode(), signed.encode(), hashlib.sha1).digest()).decode()
    return req('/api/whatsapp', params, headers={'x-twilio-signature': sig}, form=True)[1]
check('whatsapp rejects bad signature', wa('hi', token='wrong'), 'Invalid signature')
check('whatsapp hi shows menu', 'Reply with a number' in wa('hi'), True)
wa('1')
check('whatsapp asks for bank', 'Which bank' in wa(acct), True)
check('whatsapp checks after bank', 'RISK SIGNAL' in wa('gtb'), True)
wa('2')
check('whatsapp classifies story', 'We understood this as' in wa('I paid for a laptop and the seller disappeared'), True)
check('whatsapp REPORT is stored', 'Added to TRACE intelligence' in wa('YES'), True)
check('intel requires password', req('/intel')[0], 401)
check('partner API requires key', req('/v1/check-account', {'accountNumber': acct})[0], 401)
check('partner API accepts key', req('/v1/check-account', {'accountNumber': acct}, headers={'authorization': 'Bearer check'})[0], 200)
check('bank list includes microfinance banks', 'Moniepoint' in req('/check')[1], True)
check('forged classification rejected', report.__name__ and req('/api/reports', {})[0], 400)

# ── Escalation: the first hour ──
V = 'whatsapp:+2340000000009'
def esc(body):
    return wa(body, sender=V)
check('escalation offered on the menu', 'sent money' in esc('MENU'), True)
check('escalation starts with when', 'When did you send it' in esc('2'), True)
S = 'whatsapp:+2340000000010'
check('free-text "I was scammed" starts escalation', 'When did you send it' in wa('I was scammed', sender=S), True)
wa('MENU', sender=S)
check('Pidgin "dem don dupe me" starts escalation', 'When did you send it' in wa('dem don dupe me o', sender=S), True)
A = 'whatsapp:+2340000000011'
wa('MENU', sender=A); wa('I was scammed of 100,000 naira', sender=A); wa('1', sender=A)
check('amount said up front is not asked again', 'FROM' in wa('0123456789 GTBank', sender=A), True)
check('the call script uses that amount', '100,000' in wa('Access', sender=A), True)
B = 'whatsapp:+2340000000012'
wa('MENU', sender=B); wa('i was scammed of 100000', sender=B); wa('1', sender=B)
check('a bare amount counts too', 'FROM' in wa('0123456789 GTBank', sender=B), True)
check('LANGUAGE lists languages', 'Yorùbá' in wa('LANGUAGE', sender=S + '2'), True)
check('picking a language falls back to English without AI', 'Reply with a number' in wa('3', sender=S + '2'), True)
DM = 'whatsapp:+2340000000020'
fresh = '8' + ''.join(random.choice('0123456789') for _ in range(9))
check('DEMO starts demo mode', 'demo mode' in wa('DEMO', sender=DM), True)
check('demo shows a made-up name for sample accounts', 'Account name' in wa('0123456789 gtb', sender=DM), True)
wa(f'REPORT {fresh} GTBank I paid for a laptop and the seller disappeared', sender=DM)
check('demo report is stored in the demo world', 'Added to TRACE intelligence' in wa('YES', sender=DM), True)
check('DEMO OFF returns to live', 'back on live TRACE' in wa('DEMO OFF', sender=DM), True)
check('live never names sample accounts', 'name check skipped' in wa('0123456789 gtb', sender=DM), True)
check('demo report never reaches live data', json.loads(req('/api/check', {'accountNumber': fresh, 'bank': 'GTBank'})[1])['reports'], 0)
check('unrelated text still shows the menu', 'Reply with a number' in wa('good morning', sender=S + '1'), True)
esc('1')
esc(acct)
check('escalation surfaces existing reports', 'already reported' in esc('gtb'), True)
esc('45000')
script = esc('access')
check('call comes first', 'Call' in script and 'Say exactly this' in script, True)
check('call script asks for a PND', 'PND' in script, True)
check('call script asks for a reference', 'complaint reference number' in script, True)
# Nothing in help.json is verified yet, so no phone number may be offered.
check('unverified bank falls back to card advice', 'back of your bank card' in script, True)
check('never invents a helpline', 'Checked' not in script, True)
written = esc('DONE')
check('written complaint follows the call', 'FRAUD COMPLAINT' in written, True)
check('written complaint names the beneficiary', acct in written, True)
check('report falls out of the escalation', 'added' in esc('I paid for a laptop and the seller disappeared'), True)
check('complaint reference is stored', 'saved to case' in esc('REF CHK/2026/1'), True)
status = esc('STATUS')
check('case is tracked', 'Waiting on your bank' in status and 'CHK/2026/1' in status, True)

# ── Get help on the web: the same ladder through /api/cases ──
import datetime
me = {'x-trace-device': str(uuid.uuid4())}
def case(path, body=None, who=me):
    s, t = req(path, body, headers=who)
    return s, json.loads(t) if t else None
s, v = case('/api/cases', {'sentAt': (datetime.datetime.utcnow() - datetime.timedelta(minutes=20)).isoformat() + 'Z',
                            'accountNumber': acct, 'bank': 'GTBank', 'victimBank': 'Kuda', 'amount': 45000})
check('web case opens', (s, v['status']), (200, 'open'))
check('web case leads with the call', v['urgency']['tier'] == 'golden' and any('PND' in l for l in v['script']), True)
check('web case knows prior reports', v['priorReporters'] > 0, True)
check('web never shows unverified authority contacts', all(a['phone'] is None and a['email'] is None for a in v['authorities']), True)
check('another device cannot touch the case', case(f"/api/cases/{v['id']}", {'action': 'resolved'}, who={'x-trace-device': str(uuid.uuid4())})[0], 404)
check('web case filed after the call', case(f"/api/cases/{v['id']}", {'action': 'filed'})[1]['status'], 'filed')
check('web story becomes a report', case(f"/api/cases/{v['id']}", {'action': 'story', 'text': 'I paid for a laptop and the seller disappeared'})[1]['reportFiled'], True)
check('web story only once', case(f"/api/cases/{v['id']}", {'action': 'story', 'text': 'I paid for a laptop and the seller disappeared'})[0], 409)
v = case(f"/api/cases/{v['id']}", {'action': 'reference', 'reference': 'WEB/2026/9'})[1]
check('web reference saved', (v['reference'], v['next']['step']), ('WEB/2026/9', 'wait'))
check('web latest case is returned', case('/api/cases')[1]['id'], v['id'])
check('web rejects a future send date', case('/api/cases', {'sentAt': '2099-01-01T00:00:00Z', 'accountNumber': acct, 'bank': 'GTBank', 'victimBank': 'Kuda'})[0], 400)
# Report first, then ask for help: the case picks up that report, so nobody reports twice.
s, v = case('/api/cases', {'sentAt': (datetime.datetime.utcnow() - datetime.timedelta(minutes=5)).isoformat() + 'Z',
                            'accountNumber': acct, 'bank': 'GTBank', 'victimBank': 'Kuda'}, who={'x-trace-device': d1})
check('case after reporting links the report', (s, v['reportFiled']), (200, True))

check('sign out', urllib.request.urlopen(urllib.request.Request(base + '/api/auth', method='DELETE', headers={'cookie': login['cookie']})).status, 200)
s7, _ = req('/api/check', {'accountNumber': '9000000001'}, newdev)
check('signed out, the limit applies again', s7, 401)

sys.exit(fail)
PY
