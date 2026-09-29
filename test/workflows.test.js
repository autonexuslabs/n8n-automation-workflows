// Two kinds of checks:
//   1. structure: every workflow file is valid n8n JSON (unique names, every
//      connection points at a real node, no real credential ids committed)
//   2. behaviour: the JavaScript inside the Code nodes is extracted and run
//      against stub inputs, so the logic that matters is tested outside n8n.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'

const dir = new URL('../workflows/', import.meta.url)
const workflows = Object.fromEntries(readdirSync(dir).filter((f) => f.endsWith('.json')).map((f) => [f, JSON.parse(readFileSync(new URL(f, dir), 'utf8'))]))

const codeOf = (wf, name) => workflows[wf].nodes.find((n) => n.name === name).parameters.jsCode

/** Run a Code node's JavaScript with n8n-shaped stubs. */
function run(jsCode, { input = [], nodes = {}, staticData = {} } = {}) {
  const wrap = (items) => ({ all: () => items.map((json) => ({ json })), first: () => ({ json: items[0] }) })
  const $input = wrap(input)
  const $ = (name) => wrap(nodes[name] ?? [])
  const fn = new Function('$input', '$', '$getWorkflowStaticData', jsCode)
  return fn($input, $, () => staticData).map((i) => i.json)
}

test('every workflow is structurally valid', () => {
  assert.ok(Object.keys(workflows).length >= 5)
  for (const [file, wf] of Object.entries(workflows)) {
    const names = wf.nodes.map((n) => n.name)
    assert.equal(new Set(names).size, names.length, `${file}: duplicate node names`)
    assert.equal(new Set(wf.nodes.map((n) => n.id)).size, names.length, `${file}: duplicate ids`)
    for (const [from, { main }] of Object.entries(wf.connections)) {
      assert.ok(names.includes(from), `${file}: connection from unknown node ${from}`)
      for (const branch of main) for (const c of branch) assert.ok(names.includes(c.node), `${file}: connection to unknown node ${c.node}`)
    }
    for (const n of wf.nodes) {
      assert.match(n.type, /^n8n-nodes-base\./, `${file}: ${n.name}`)
      for (const cred of Object.values(n.credentials ?? {})) assert.equal(cred.id, 'REPLACE_ME', `${file}: ${n.name} carries a real credential id`)
    }
  }
})

test('every Code node is valid JavaScript', () => {
  for (const [file, wf] of Object.entries(workflows)) {
    for (const n of wf.nodes.filter((x) => x.type === 'n8n-nodes-base.code')) {
      assert.doesNotThrow(() => new Function('$input', '$', '$getWorkflowStaticData', n.parameters.jsCode), `${file}: ${n.name}`)
    }
  }
})

test('01 · Places results are flattened, deduped across queries, closed ones dropped', () => {
  const out = run(codeOf('01-local-business-leads-to-sheets.json', 'Flatten + dedupe'), {
    input: [
      { places: [
        { id: 'a', displayName: { text: 'Ozark Pipe' }, nationalPhoneNumber: '(417) 555-0131', websiteUri: 'https://ozark.example', businessStatus: 'OPERATIONAL' },
        { id: 'b', displayName: { text: 'Closed Co' }, businessStatus: 'CLOSED_PERMANENTLY' },
      ] },
      { places: [
        { id: 'c', displayName: { text: 'Ozark Pipe (Joplin)' }, nationalPhoneNumber: '417.555.0131' },
        { id: 'd', displayName: { text: 'Four States' }, websiteUri: 'https://www.fourstates.example/' },
      ] },
    ],
    nodes: { 'One item per query': [{ query: 'plumber in Springfield' }, { query: 'plumber in Joplin' }] },
  })
  assert.deepEqual(out.map((r) => [r.placeId, r.query]), [['a', 'plumber in Springfield'], ['d', 'plumber in Joplin']])
})

test('02 · website lead is cleaned and emergencies are flagged', () => {
  const js = codeOf('02-website-lead-to-crm.json', 'Validate + normalise')
  const lead = (body) => run(js, { nodes: { 'Lead webhook': [{ body }] } })[0]
  const a = lead({ name: ' Dana ', phone: '+1 816.555.0142', message: 'AC is blowing warm air' })
  assert.equal(a.phone, '(816) 555-0142')
  assert.equal(a.emergency, false)
  assert.equal(a.valid, true)
  assert.equal(lead({ name: 'Jo', email: 'jo@x.example', message: 'strong gas smell in the basement' }).emergency, true)
  assert.equal(lead({ message: 'hi' }).valid, false)
})

test('03 · only human replies pass, opt-outs are recognised, "stop by" is not one', () => {
  const js = codeOf('03-lead-replied-gmail.json', 'Classify reply')
  const mail = (from, subject, text, headers = {}) => ({ from: { value: [{ address: from }] }, subject, text, headers, id: 'm', threadId: 't' })
  const out = run(js, { nodes: { 'New inbox mail': [
    mail('mailer-daemon@x.example', 'Delivery Status Notification', 'failed'),
    mail('a@x.example', 'Automatic reply: hi', 'away'),
    mail('b@x.example', 'Re: hi', "I'll stop by the office Monday"),
    mail('c@x.example', 'Re: hi', 'STOP'),
    mail('d@x.example', 'Re: hi', 'Sounds good\n\nOn Mon, Alex wrote:\n> reply stop to opt out'),
  ] } })
  assert.deepEqual(out.map((r) => [r.email, r.optOut]), [['b@x.example', false], ['c@x.example', true], ['d@x.example', false]])
  assert.equal(out[2].text, 'Sounds good')
})

test('04 · the draft is scanned for prices, guarantees and time promises', () => {
  const js = codeOf('04-ai-reply-drafts-gmail.json', 'Read draft + scan')
  const scan = (draft) => run(js, {
    input: [{ content: [{ type: 'text', text: '' }, { type: 'tool_use', name: 'draft_reply', input: { intent: 'quote_request', draft, needs_human: false } }] }],
    nodes: { 'Emergency check': [{ from: 'k@x.example', subject: 'Cost?' }] },
  })[0]
  assert.equal(scan('A technician gives a free written estimate.').needsHuman, false)
  const bad = scan('It is about $3,500 and we guarantee same-day service.')
  assert.equal(bad.needsHuman, true)
  assert.equal(bad.flags, 'mentions a price, makes a guarantee, promises a time')
  assert.throws(() => run(js, { input: [{ content: [{ type: 'text', text: 'hi' }] }], nodes: { 'Emergency check': [{}] } }), /no draft_reply/)
})

test('04 · emergencies are caught before the model', () => {
  const js = codeOf('04-ai-reply-drafts-gmail.json', 'Emergency check')
  const check = (subject, text) => run(js, { nodes: { 'New inquiry': [{ subject, text, from: { value: [{ address: 'a@x.example' }] } }] } })[0].emergency
  assert.equal(check('Smell', 'strong gas smell by the furnace'), true)
  assert.equal(check('Quote', 'we have a gas furnace, how old is too old?'), false)
})

test('05 · watchdog alerts once on the way down and once on the way up', () => {
  const js = codeOf('05-uptime-watchdog.json', 'Decide alerts')
  const staticData = {}
  const tick = (code) => run(js, { input: [{ statusCode: code }], nodes: { 'One item per URL': [{ url: 'https://shop.example' }] }, staticData })
  assert.deepEqual(tick(200), [])
  assert.deepEqual(tick(502), [])
  assert.match(tick(502)[0].text, /DOWN \(502\)/)
  assert.deepEqual(tick(502), [])
  assert.match(tick(200)[0].text, /back up after \d+ min/)
  assert.deepEqual(tick(200), [])
})
