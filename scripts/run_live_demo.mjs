import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { execSync } from 'child_process';
import { fileURLToPath } from 'url';
import { createClient, createAccount, generatePrivateKey } from 'genlayer-js';
import { studionet } from 'genlayer-js/chains';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, '..');
const STATE_FILE = path.join(__dirname, 'state.json');
const MANIFEST_FILE = path.join(ROOT_DIR, 'release_manifest.json');
const CONTRACT_FILE = path.join(ROOT_DIR, 'contracts', 'mandate_tree.py');
const PROBE_FILE = path.join(__dirname, 'probe.py');

const STUDIO_RPC = 'https://studio.genlayer.com/api';

function sha256(bufOrStr) {
  return crypto.createHash('sha256').update(bufOrStr).digest('hex');
}

function loadState() {
  if (fs.existsSync(STATE_FILE)) {
    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf-8'));
  }
  return {};
}

function saveState(patch) {
  const cur = loadState();
  const next = { ...cur, ...patch, updatedAt: new Date().toISOString() };
  fs.writeFileSync(STATE_FILE, JSON.stringify(next, null, 2));
  return next;
}

async function rawRpcCall(method, params = [], retries = 5) {
  let lastErr;
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const resp = await fetch(STUDIO_RPC, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: Date.now(), method, params })
      });
      if (!resp.ok) {
        throw new Error(`HTTP ${resp.status} on ${method}`);
      }
      const data = await resp.json();
      if (data.error) {
        throw new Error(`RPC error on ${method}: ${JSON.stringify(data.error)}`);
      }
      return data.result;
    } catch (err) {
      lastErr = err;
      console.warn(`  [RPC ${method} attempt ${attempt} warning]: ${err.message || err}`);
      if (attempt < retries) {
        await new Promise(r => setTimeout(r, 3000 * attempt));
      }
    }
  }
  throw lastErr;
}

function createStudioClient(account) {
  return createClient({
    chain: studionet,
    endpoint: STUDIO_RPC,
    account
  });
}

const STATUS_NAMES = {
  0: 'PENDING',
  1: 'PROPOSED',
  2: 'COMMITTING',
  3: 'REVEALING',
  4: 'VOTING',
  5: 'ACCEPTED',
  6: 'UNDETERMINED',
  7: 'FINALIZED',
  8: 'CANCELED',
  9: 'APPEAL_REVEALING'
};

function normalizeReadable(val) {
  if (typeof val !== 'string') return String(val || '');
  let s = val.trim();
  while ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    try {
      const parsed = JSON.parse(s);
      if (typeof parsed === 'string') {
        s = parsed;
      } else {
        break;
      }
    } catch {
      break;
    }
  }
  return s;
}

function extractResultInfo(tx) {
  let statusName = tx.status_name || '';
  if (!statusName && tx.status !== undefined) {
    statusName = STATUS_NAMES[tx.status] || String(tx.status);
  }
  let resultName = tx.result_name || '';
  if (!resultName && tx.result !== undefined) {
    resultName = String(tx.result);
  }
  const receipt = tx.consensus_data?.leader_receipt?.[0] || {};
  const execResult = receipt.execution_result || '';
  const stderr = receipt.genvm_result?.stderr || '';
  const readableRaw = receipt.result?.payload?.readable;
  const readableStr = typeof readableRaw === 'string'
    ? normalizeReadable(readableRaw)
    : (readableRaw !== undefined ? JSON.stringify(readableRaw) : '');
  const votes = tx.consensus_data?.votes || {};
  const contractAddress = tx.data?.contract_address || tx.contract_address || '';
  return { statusName, resultName, execResult, stderr, readableStr, votes, contractAddress };
}

async function waitForReceipt(client, txHash, { expectSuccess = true, maxAttempts = 120, intervalMs = 5000 } = {}) {
  console.log(`[POLL] Waiting for tx ${txHash} (expectSuccess=${expectSuccess})...`);
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    await new Promise(r => setTimeout(r, intervalMs));
    try {
      const tx = await client.getTransaction({ hash: txHash });
      if (!tx) continue;
      const info = extractResultInfo(tx);
      console.log(`  [Attempt ${attempt}/${maxAttempts}] status=${info.statusName} result=${info.resultName} GenVM=${info.execResult}`);
      if (info.statusName === 'FINALIZED' || info.statusName === 'UNDETERMINED') {
        if (info.statusName === 'UNDETERMINED') {
          throw new Error(`Transaction ${txHash} ended UNDETERMINED`);
        }
        if (expectSuccess && info.execResult && info.execResult !== 'SUCCESS') {
          throw new Error(`Transaction ${txHash} finalized with GenVM ${info.execResult} (expected SUCCESS). stderr=${info.stderr} readable=${info.readableStr}`);
        }
        if (!expectSuccess && info.execResult === 'SUCCESS') {
          throw new Error(`Transaction ${txHash} unexpectedly SUCCEEDED (expected ERROR). readable=${info.readableStr}`);
        }
        return {
          finalized: true,
          status: info.statusName,
          result: info.resultName,
          executionResult: info.execResult,
          returnReadable: info.readableStr,
          stderr: info.stderr,
          votes: info.votes,
          contractAddress: info.contractAddress
        };
      }
    } catch (err) {
      if (err.message && (err.message.includes('finalized with GenVM') || err.message.includes('unexpectedly SUCCEEDED') || err.message.includes('UNDETERMINED'))) {
        throw err;
      }
      console.warn(`  [Poll attempt ${attempt} warning]: ${err.message || err}`);
    }
  }
  throw new Error(`Transaction ${txHash} did not finalize within ${(maxAttempts * intervalMs) / 1000}s`);
}

async function readContractWithRetry(client, { address, functionName, args = [] }, retries = 6, delayMs = 3000) {
  let lastErr;
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      return await client.readContract({ address, functionName, args });
    } catch (err) {
      lastErr = err;
      console.warn(`  [readContract ${functionName} attempt ${attempt} warning]: ${err.message || err}`);
      if (attempt < retries) await new Promise(r => setTimeout(r, delayMs * attempt));
    }
  }
  throw lastErr;
}

async function safeDeploy(client, code, retries = 5) {
  let txHash = null;
  let lastErr = null;
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      txHash = await client.deployContract({ code });
      console.log(`  -> deployContract sent, txHash: ${txHash}`);
      break;
    } catch (err) {
      lastErr = err;
      console.warn(`  [deployContract attempt ${attempt} warning]: ${err.message || err}`);
      if (attempt < retries) await new Promise(r => setTimeout(r, 4000 * attempt));
    }
  }
  if (!txHash) {
    throw new Error(`Failed to deploy after ${retries} attempts: ${lastErr?.message || lastErr}`);
  }
  const receipt = await waitForReceipt(client, txHash, { expectSuccess: true });
  return { txHash, receipt };
}

async function safeWrite(client, { address, functionName, args = [], value = 0n, expectSuccess = true, retries = 5 }) {
  let txHash = null;
  let lastErr = null;
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      txHash = await client.writeContract({ address, functionName, args, value });
      console.log(`  -> writeContract ${functionName} sent, txHash: ${txHash}`);
      break;
    } catch (err) {
      lastErr = err;
      console.warn(`  [writeContract ${functionName} attempt ${attempt} warning]: ${err.message || err}`);
      if (attempt < retries) await new Promise(r => setTimeout(r, 4000 * attempt));
    }
  }
  if (!txHash) {
    throw new Error(`Failed to send writeContract ${functionName} after ${retries} attempts: ${lastErr?.message || lastErr}`);
  }
  const receipt = await waitForReceipt(client, txHash, { expectSuccess });
  return { txHash, receipt };
}

function assertExpectedReturn(step, actual, expected) {
  const normActual = normalizeReadable(actual);
  const normExpected = normalizeReadable(expected);
  if (normExpected && normActual !== normExpected) {
    throw new Error(`STOP: Step ${step} landed unexpectedly! expected="${normExpected}" got="${normActual}"`);
  }
}

async function main() {
  console.log('===============================================================');
  console.log('  MandateTree: StudioNet Probe, Native Deploy & Live Demo      ');
  console.log('===============================================================');

  let state = loadState();
  const ROLES = ['root', 'leadOnco', 'leadRadio', 'subPet', 'subBiopsy', 'attacker'];
  if (!state.keys) {
    const keys = {};
    for (const role of ROLES) {
      const pk = generatePrivateKey();
      const acc = createAccount(pk);
      keys[role] = { privateKey: pk, address: acc.address };
    }
    state = saveState({ keys });
    console.log('Generated 6 fresh dedicated MandateTree accounts in gitignored state.json');
  }

  const accounts = {};
  const clients = {};
  for (const role of ROLES) {
    accounts[role] = createAccount(state.keys[role].privateKey);
    clients[role] = createStudioClient(accounts[role]);
    console.log(`${role.padEnd(10)}: ${accounts[role].address}`);
  }

  // Fund Root and Attacker via sim_fundAccount for Option A real native payable transfers
  const fundingInfo = state.funding || {};
  for (const role of ['root', 'attacker']) {
    const addr = accounts[role].address;
    let balHex = await rawRpcCall('eth_getBalance', [addr, 'latest']);
    let balWei = BigInt(balHex || '0x0');
    if (balWei < 10000n) {
      console.log(`Funding ${role} (${addr}) with 1,000,000 wei via sim_fundAccount...`);
      const fundTx = await rawRpcCall('sim_fundAccount', [addr, 1000000]);
      await new Promise(r => setTimeout(r, 3000));
      balHex = await rawRpcCall('eth_getBalance', [addr, 'latest']);
      balWei = BigInt(balHex || '0x0');
      fundingInfo[role] = {
        address: addr,
        simFundAccountTx: fundTx,
        fundedBalanceWei: balWei.toString()
      };
      console.log(`  -> Funded ${role}: balance=${balWei.toString()} wei`);
    } else if (!fundingInfo[role]) {
      fundingInfo[role] = { address: addr, fundedBalanceWei: balWei.toString() };
    }
  }
  state = saveState({ funding: fundingInfo });

  const commitSha = execSync('git rev-parse HEAD', { cwd: ROOT_DIR, encoding: 'utf-8' }).trim();
  const blobSha = execSync('git rev-parse HEAD:contracts/mandate_tree.py', { cwd: ROOT_DIR, encoding: 'utf-8' }).trim();
  const contractCode = fs.readFileSync(CONTRACT_FILE, 'utf-8');
  const localContractSha256 = sha256(contractCode);

  console.log(`Deploy Commit SHA: ${commitSha}`);
  console.log(`Git Blob Hash    : ${blobSha}`);
  console.log(`Contract SHA-256 : ${localContractSha256}`);

  const EVIDENCE_NAMES = [
    'root_charter.json',
    'onco_charter.json',
    'radio_charter.json',
    'onco_dup_charter.json',
    'onco_escalate_charter.json',
    'onco_pet_charter.json',
    'breach_compliant_audit.json',
    'breach_violation_incident.json'
  ];

  const EVIDENCES = {};
  const evidenceManifestList = [];
  for (const fname of EVIDENCE_NAMES) {
    const raw = fs.readFileSync(path.join(ROOT_DIR, 'evidence', fname));
    const h = sha256(raw);
    const url = `https://raw.githubusercontent.com/Kanezar3/Mandate-Tree/${commitSha}/evidence/${fname}`;
    EVIDENCES[fname] = { url, hash: h, size: raw.length };
    evidenceManifestList.push({ file: `evidence/${fname}`, url, sha256: h, size: raw.length });
  }

  const history = state.history || [];

  function writeManifest() {
    const cur = loadState();
    const manifest = {
      projectName: 'MandateTree',
      humanName: 'Mandate Tree',
      description: 'Delegation Tree with Exclusive Budget and Scope Reservations (Option A: Real Native Value Transfers) on GenLayer StudioNet',
      repositoryUrl: 'https://github.com/Kanezar3/Mandate-Tree',
      deployCommitSha: commitSha,
      contractPath: 'contracts/mandate_tree.py',
      gitBlobHash: blobSha,
      localContractSha256,
      onChainCodeSha256: cur.onChainSha256 || '',
      blobEqualityVerified: cur.blobEquality || false,
      settlementMode: 'OPTION_A_REAL_NATIVE_PAYABLE',
      probeContractAddress: cur.probeAddress || '',
      probeDeployTxHash: cur.probeDeployTx || '',
      probeSetTxHash: cur.probeSetTx || '',
      probeVerifiedValue: cur.probeVal || '',
      mainContractAddress: cur.mainAddress || '',
      mainDeployTxHash: cur.mainDeployTx || '',
      chain: {
        chainId: 61999,
        network: 'GenLayer StudioNet',
        rpcUrl: STUDIO_RPC,
        explorerUrl: 'https://explorer-studio.genlayer.com'
      },
      accounts: Object.fromEntries(ROLES.map(r => [r, accounts[r].address])),
      funding: cur.funding || {},
      evidenceFiles: evidenceManifestList,
      transactions: cur.history || []
    };
    fs.writeFileSync(MANIFEST_FILE, JSON.stringify(manifest, null, 2) + '\n');
  }

  function recordStep(stepObj) {
    const idx = history.findIndex(h => h.step === stepObj.step);
    if (idx >= 0) history[idx] = stepObj;
    else history.push(stepObj);
    saveState({ history });
    writeManifest();
    console.log(`  [RECORDED ${stepObj.step}] ${stepObj.method} | Hash: ${stepObj.hash} | Status: ${stepObj.status} | Exec: ${stepObj.executionResult} | Out: ${stepObj.returnOrError}`);
  }

  // ---------------------------------------------------------------------------
  // Step 3A: Runner Probe
  // ---------------------------------------------------------------------------
  if (!state.probeAddress || state.probeVal !== 'probe_ok') {
    console.log('\n--- Step 3A: Deploying Runner Probe ---');
    const probeCode = fs.readFileSync(PROBE_FILE, 'utf-8');
    const { txHash: probeDeployTx, receipt: probeReceipt } = await safeDeploy(clients.root, probeCode);
    const probeAddress = probeReceipt.contractAddress;
    state = saveState({ probeAddress, probeDeployTx });
    console.log(`Probe deployed at: ${probeAddress}`);

    const { txHash: probeSetTx } = await safeWrite(clients.root, {
      address: probeAddress,
      functionName: 'set_val',
      args: ['probe_ok'],
      expectSuccess: true
    });
    const probeVal = await readContractWithRetry(clients.root, {
      address: probeAddress,
      functionName: 'get_val',
      args: []
    });
    if (probeVal !== 'probe_ok') {
      throw new Error(`Probe check failed: expected probe_ok, got ${probeVal}`);
    }
    state = saveState({ probeSetTx, probeVal });
    writeManifest();
    console.log('[PASS] Step 3A Runner Probe verified!');
  } else {
    console.log(`Probe already verified at: ${state.probeAddress}`);
  }

  // ---------------------------------------------------------------------------
  // Step 3B: Deploy MandateTree & Verify Byte-for-Byte Equality
  // ---------------------------------------------------------------------------
  if (!state.mainAddress) {
    console.log('\n--- Step 3B: Deploying MandateTree ---');
    const { txHash: mainDeployTx, receipt: mainReceipt } = await safeDeploy(clients.root, contractCode);
    state = saveState({ mainAddress: mainReceipt.contractAddress, mainDeployTx });
    console.log(`MandateTree deployed at: ${state.mainAddress}`);
    writeManifest();
  } else {
    console.log(`MandateTree already deployed at: ${state.mainAddress}`);
  }

  const MAIN_ADDR = state.mainAddress;

  if (!state.blobEquality) {
    console.log('Verifying byte-for-byte on-chain code equality...');
    const onChainCode = await clients.root.getContractCode(MAIN_ADDR);
    const onChainSha256 = sha256(onChainCode);
    const blobEquality = (onChainCode === contractCode) && (onChainSha256 === localContractSha256);
    console.log(`On-chain SHA-256 : ${onChainSha256}`);
    console.log(`Blob equality    : ${blobEquality ? 'MATCH (100%)' : 'MISMATCH'}`);
    state = saveState({ onChainSha256, blobEquality });
    writeManifest();
    if (!blobEquality) {
      throw new Error('CRITICAL: Bytecode mismatch between local file and deployed StudioNet contract!');
    }
  }

  async function readAccounting() {
    const raw = await readContractWithRetry(clients.root, {
      address: MAIN_ADDR,
      functionName: 'get_accounting_summary',
      args: []
    });
    const parsed = JSON.parse(raw);
    if (!parsed.conservation_ok) {
      throw new Error(`CRITICAL: conservation_ok is FALSE! ${raw}`);
    }
    return parsed;
  }

  async function readMandate(id) {
    const raw = await readContractWithRetry(clients.root, {
      address: MAIN_ADDR,
      functionName: 'get_mandate',
      args: [id]
    });
    return JSON.parse(raw);
  }

  // Scope summaries aligned 100% with evidence/*.json
  const SCOPES = {
    root: 'Global Clinical Genomics & Trial Oversight covering non-commercial oncology biomarker research, diagnostic medical imaging and radiology hardware safety audits, and academic clinical trial biostatistics across EU, North America, and APAC; prohibits commercial pharmaceutical retail marketing or advertising.',
    onco: 'EU and North America Phase-II non-commercial oncology biomarker assays (PET-CT and liquid biopsy) and academic oncology cohort biostatistics; excludes APAC operations, radiology hardware audits, and commercial marketing.',
    radio: 'APAC (Japan, Singapore, Australia) diagnostic MRI and CT radiology hardware calibration, radiation dosimetry safety verification, and imaging device QA; excludes EU/NA operations, oncology biomarker assays, and commercial marketing.',
    onco_dup: 'EU and North America Phase-II oncology clinical biomarker assays and cohort biostatistics.',
    onco_escalate: 'Global worldwide direct-to-consumer commercial television advertising campaigns and retail pharmacy point-of-sale drug promotions and commercial sales marketing.',
    onco_pet: 'EU clinical trial sites only Phase-II PET-CT oncology biomarker assay protocol execution and academic statistical validation of EU oncology PET-CT cohort endpoints; excludes North America, APAC, hardware manufacturing, and commercial advertising.',
    onco_pending: 'North America Phase-II liquid biopsy oncology biomarker assay standardization and non-commercial academic cohort QA.'
  };

  // ---------------------------------------------------------------------------
  // Live Demo Suite: S1–S17 + X1–X9 (26 Transactions)
  // ---------------------------------------------------------------------------

  // X1: Attacker attempts initialize_tree
  if (!history.find(h => h.step === 'X1')) {
    console.log('\n--- X1: Attacker initialize_tree blocked ---');
    const { txHash, receipt } = await safeWrite(clients.attacker, {
      address: MAIN_ADDR,
      functionName: 'initialize_tree',
      args: [1000, 3600, SCOPES.root, EVIDENCES['root_charter.json'].url, EVIDENCES['root_charter.json'].hash],
      value: 1000n,
      expectSuccess: false
    });
    recordStep({
      step: 'X1',
      scenario: 'Unauthorized Caller initialize_tree Blocked',
      method: 'initialize_tree',
      caller: 'Attacker',
      valueWei: '1000',
      hash: txHash,
      status: receipt.status,
      executionResult: receipt.executionResult,
      returnOrError: receipt.returnReadable || receipt.stderr,
      votes: receipt.votes,
      expected: 'UNAUTHORIZED_CALLER',
      expectedFailure: true
    });
  }

  // S1: Root initializes tree with 1000 wei native value
  if (!history.find(h => h.step === 'S1')) {
    console.log('\n--- S1: Root initialize_tree (1000 wei payable, 3600s) ---');
    const { txHash, receipt } = await safeWrite(clients.root, {
      address: MAIN_ADDR,
      functionName: 'initialize_tree',
      args: [1000, 3600, SCOPES.root, EVIDENCES['root_charter.json'].url, EVIDENCES['root_charter.json'].hash],
      value: 1000n,
      expectSuccess: true
    });
    assertExpectedReturn('S1', receipt.returnReadable, 'TREE_INITIALIZED:root');
    const statusRaw = await readContractWithRetry(clients.root, { address: MAIN_ADDR, functionName: 'get_tree_status' });
    const accounting = await readAccounting();
    recordStep({
      step: 'S1',
      scenario: 'Root Tree Initialization (1000 wei Payable, 3600s Duration)',
      method: 'initialize_tree',
      caller: 'Root',
      valueWei: '1000',
      hash: txHash,
      status: receipt.status,
      executionResult: receipt.executionResult,
      returnOrError: receipt.returnReadable,
      votes: receipt.votes,
      expected: 'TREE_INITIALIZED:root',
      expectedFailure: false,
      readBack: { treeStatus: JSON.parse(statusRaw), accounting }
    });
  }

  // X2: Unpinned /main/ URL blocked
  if (!history.find(h => h.step === 'X2')) {
    console.log('\n--- X2: Unpinned /main/ evidence URL blocked ---');
    const badUrl = 'https://raw.githubusercontent.com/Kanezar3/Mandate-Tree/main/evidence/onco_charter.json';
    const { txHash, receipt } = await safeWrite(clients.root, {
      address: MAIN_ADDR,
      functionName: 'propose_mandate',
      args: ['root', 'bad_url', accounts.leadOnco.address, 100, SCOPES.onco, badUrl, EVIDENCES['onco_charter.json'].hash],
      expectSuccess: false
    });
    recordStep({
      step: 'X2',
      scenario: 'Unpinned Mutable Branch URL Blocked',
      method: 'propose_mandate',
      caller: 'Root',
      hash: txHash,
      status: receipt.status,
      executionResult: receipt.executionResult,
      returnOrError: receipt.returnReadable || receipt.stderr,
      votes: receipt.votes,
      expected: 'INVALID_EVIDENCE_URL',
      expectedFailure: true
    });
  }

  // X3: Attacker attempts propose_mandate under root
  if (!history.find(h => h.step === 'X3')) {
    console.log('\n--- X3: Unauthorized delegator propose_mandate blocked ---');
    const { txHash, receipt } = await safeWrite(clients.attacker, {
      address: MAIN_ADDR,
      functionName: 'propose_mandate',
      args: ['root', 'unauth_node', accounts.attacker.address, 100, SCOPES.onco, EVIDENCES['onco_charter.json'].url, EVIDENCES['onco_charter.json'].hash],
      expectSuccess: false
    });
    recordStep({
      step: 'X3',
      scenario: 'Unauthorized Delegator Blocked (Strict Authority Binding)',
      method: 'propose_mandate',
      caller: 'Attacker',
      hash: txHash,
      status: receipt.status,
      executionResult: receipt.executionResult,
      returnOrError: receipt.returnReadable || receipt.stderr,
      votes: receipt.votes,
      expected: 'UNAUTHORIZED_DELEGATOR',
      expectedFailure: true
    });
  }

  // S2: Root proposes Level-1 onco (600 wei)
  if (!history.find(h => h.step === 'S2')) {
    console.log('\n--- S2: Root proposes Level-1 mandate onco (600 wei) ---');
    const { txHash, receipt } = await safeWrite(clients.root, {
      address: MAIN_ADDR,
      functionName: 'propose_mandate',
      args: ['root', 'onco', accounts.leadOnco.address, 600, SCOPES.onco, EVIDENCES['onco_charter.json'].url, EVIDENCES['onco_charter.json'].hash],
      expectSuccess: true
    });
    assertExpectedReturn('S2', receipt.returnReadable, 'PROPOSED:onco:PARENT_root');
    const mandate = await readMandate('onco');
    const accounting = await readAccounting();
    recordStep({
      step: 'S2',
      scenario: 'Propose Level-1 Mandate onco (600 wei Reserved)',
      method: 'propose_mandate',
      caller: 'Root',
      hash: txHash,
      status: receipt.status,
      executionResult: receipt.executionResult,
      returnOrError: receipt.returnReadable,
      votes: receipt.votes,
      expected: 'PROPOSED:onco:PARENT_root',
      expectedFailure: false,
      readBack: { mandate, accounting }
    });
  }

  // S3: Permissionless audit_mandate("onco") -> APPROVED
  if (!history.find(h => h.step === 'S3')) {
    console.log('\n--- S3: Audit Level-1 mandate onco (Vertical Attenuation) ---');
    const { txHash, receipt } = await safeWrite(clients.leadOnco, {
      address: MAIN_ADDR,
      functionName: 'audit_mandate',
      args: ['onco'],
      expectSuccess: true
    });
    assertExpectedReturn('S3', receipt.returnReadable, 'AUDIT_APPROVED:onco:SUBSUMED_AND_EXCLUSIVE');
    const mandate = await readMandate('onco');
    const accounting = await readAccounting();
    recordStep({
      step: 'S3',
      scenario: 'LLM Consensus Audit: onco Approved (Vertical Attenuation)',
      method: 'audit_mandate',
      caller: 'LeadOnco',
      hash: txHash,
      status: receipt.status,
      executionResult: receipt.executionResult,
      returnOrError: receipt.returnReadable,
      votes: receipt.votes,
      expected: 'AUDIT_APPROVED:onco:SUBSUMED_AND_EXCLUSIVE',
      expectedFailure: false,
      readBack: { mandate, accounting }
    });
  }

  // X4: Re-audit concluded APPROVED mandate onco blocked
  if (!history.find(h => h.step === 'X4')) {
    console.log('\n--- X4: Re-audit concluded APPROVED mandate blocked ---');
    const { txHash, receipt } = await safeWrite(clients.attacker, {
      address: MAIN_ADDR,
      functionName: 'audit_mandate',
      args: ['onco'],
      expectSuccess: false
    });
    recordStep({
      step: 'X4',
      scenario: 'Re-audit Concluded APPROVED Mandate Blocked (Immutability)',
      method: 'audit_mandate',
      caller: 'Attacker',
      hash: txHash,
      status: receipt.status,
      executionResult: receipt.executionResult,
      returnOrError: receipt.returnReadable || receipt.stderr,
      votes: receipt.votes,
      expected: 'MANDATE_ALREADY_CONCLUDED',
      expectedFailure: true
    });
  }

  // S4: Root proposes Level-1 disjoint sibling radio (300 wei)
  if (!history.find(h => h.step === 'S4')) {
    console.log('\n--- S4: Root proposes Level-1 disjoint sibling radio (300 wei) ---');
    const { txHash, receipt } = await safeWrite(clients.root, {
      address: MAIN_ADDR,
      functionName: 'propose_mandate',
      args: ['root', 'radio', accounts.leadRadio.address, 300, SCOPES.radio, EVIDENCES['radio_charter.json'].url, EVIDENCES['radio_charter.json'].hash],
      expectSuccess: true
    });
    assertExpectedReturn('S4', receipt.returnReadable, 'PROPOSED:radio:PARENT_root');
    const mandate = await readMandate('radio');
    const accounting = await readAccounting();
    recordStep({
      step: 'S4',
      scenario: 'Propose Level-1 Disjoint Sibling radio (300 wei Reserved)',
      method: 'propose_mandate',
      caller: 'Root',
      hash: txHash,
      status: receipt.status,
      executionResult: receipt.executionResult,
      returnOrError: receipt.returnReadable,
      votes: receipt.votes,
      expected: 'PROPOSED:radio:PARENT_root',
      expectedFailure: false,
      readBack: { mandate, accounting }
    });
  }

  // S5: Permissionless audit_mandate("radio") -> APPROVED (Horizontal Exclusivity)
  if (!history.find(h => h.step === 'S5')) {
    console.log('\n--- S5: Audit Level-1 sibling radio (Horizontal Exclusivity Pass) ---');
    const { txHash, receipt } = await safeWrite(clients.leadRadio, {
      address: MAIN_ADDR,
      functionName: 'audit_mandate',
      args: ['radio'],
      expectSuccess: true
    });
    assertExpectedReturn('S5', receipt.returnReadable, 'AUDIT_APPROVED:radio:SUBSUMED_AND_EXCLUSIVE');
    const mandate = await readMandate('radio');
    const accounting = await readAccounting();
    recordStep({
      step: 'S5',
      scenario: 'LLM Consensus Audit: radio Approved (Disjoint from onco)',
      method: 'audit_mandate',
      caller: 'LeadRadio',
      hash: txHash,
      status: receipt.status,
      executionResult: receipt.executionResult,
      returnOrError: receipt.returnReadable,
      votes: receipt.votes,
      expected: 'AUDIT_APPROVED:radio:SUBSUMED_AND_EXCLUSIVE',
      expectedFailure: false,
      readBack: { mandate, accounting }
    });
  }

  // S6: Root proposes overlapping sibling onco_dup (50 wei)
  if (!history.find(h => h.step === 'S6')) {
    console.log('\n--- S6: Root proposes overlapping sibling onco_dup (50 wei) ---');
    const { txHash, receipt } = await safeWrite(clients.root, {
      address: MAIN_ADDR,
      functionName: 'propose_mandate',
      args: ['root', 'onco_dup', accounts.attacker.address, 50, SCOPES.onco_dup, EVIDENCES['onco_dup_charter.json'].url, EVIDENCES['onco_dup_charter.json'].hash],
      expectSuccess: true
    });
    assertExpectedReturn('S6', receipt.returnReadable, 'PROPOSED:onco_dup:PARENT_root');
    const accounting = await readAccounting();
    recordStep({
      step: 'S6',
      scenario: 'Propose Overlapping Sibling onco_dup (50 wei Reserved)',
      method: 'propose_mandate',
      caller: 'Root',
      hash: txHash,
      status: receipt.status,
      executionResult: receipt.executionResult,
      returnOrError: receipt.returnReadable,
      votes: receipt.votes,
      expected: 'PROPOSED:onco_dup:PARENT_root',
      expectedFailure: false,
      readBack: { accounting }
    });
  }

  // S7: Audit onco_dup -> REJECTED:SIBLING_OVERLAP + refund to root
  if (!history.find(h => h.step === 'S7')) {
    console.log('\n--- S7: Audit onco_dup (Expected REJECTED:SIBLING_OVERLAP) ---');
    const { txHash, receipt } = await safeWrite(clients.root, {
      address: MAIN_ADDR,
      functionName: 'audit_mandate',
      args: ['onco_dup'],
      expectSuccess: true
    });
    assertExpectedReturn('S7', receipt.returnReadable, 'AUDIT_REJECTED:onco_dup:SIBLING_OVERLAP');
    const mandate = await readMandate('onco_dup');
    const rootNode = await readMandate('root');
    const accounting = await readAccounting();
    recordStep({
      step: 'S7',
      scenario: 'LLM Consensus Audit: onco_dup Rejected (SIBLING_OVERLAP, 50 wei Refunded)',
      method: 'audit_mandate',
      caller: 'Root',
      hash: txHash,
      status: receipt.status,
      executionResult: receipt.executionResult,
      returnOrError: receipt.returnReadable,
      votes: receipt.votes,
      expected: 'AUDIT_REJECTED:onco_dup:SIBLING_OVERLAP',
      expectedFailure: false,
      readBack: { mandate, rootAvailableAfter: rootNode.available_budget, accounting }
    });
  }

  // S8: LeadOnco proposes out-of-scope Level-2 onco_escalate (50 wei)
  if (!history.find(h => h.step === 'S8')) {
    console.log('\n--- S8: LeadOnco proposes out-of-scope onco_escalate (50 wei) ---');
    const { txHash, receipt } = await safeWrite(clients.leadOnco, {
      address: MAIN_ADDR,
      functionName: 'propose_mandate',
      args: ['onco', 'onco_escalate', accounts.subPet.address, 50, SCOPES.onco_escalate, EVIDENCES['onco_escalate_charter.json'].url, EVIDENCES['onco_escalate_charter.json'].hash],
      expectSuccess: true
    });
    assertExpectedReturn('S8', receipt.returnReadable, 'PROPOSED:onco_escalate:PARENT_onco');
    const accounting = await readAccounting();
    recordStep({
      step: 'S8',
      scenario: 'Propose Out-of-Scope Level-2 onco_escalate (50 wei Reserved)',
      method: 'propose_mandate',
      caller: 'LeadOnco',
      hash: txHash,
      status: receipt.status,
      executionResult: receipt.executionResult,
      returnOrError: receipt.returnReadable,
      votes: receipt.votes,
      expected: 'PROPOSED:onco_escalate:PARENT_onco',
      expectedFailure: false,
      readBack: { accounting }
    });
  }

  // S9: Audit onco_escalate -> REJECTED:SCOPE_ESCALATION + refund to onco
  if (!history.find(h => h.step === 'S9')) {
    console.log('\n--- S9: Audit onco_escalate (Expected REJECTED:SCOPE_ESCALATION) ---');
    const { txHash, receipt } = await safeWrite(clients.leadOnco, {
      address: MAIN_ADDR,
      functionName: 'audit_mandate',
      args: ['onco_escalate'],
      expectSuccess: true
    });
    assertExpectedReturn('S9', receipt.returnReadable, 'AUDIT_REJECTED:onco_escalate:SCOPE_ESCALATION');
    const mandate = await readMandate('onco_escalate');
    const oncoNode = await readMandate('onco');
    const accounting = await readAccounting();
    recordStep({
      step: 'S9',
      scenario: 'LLM Consensus Audit: onco_escalate Rejected (SCOPE_ESCALATION, 50 wei Refunded)',
      method: 'audit_mandate',
      caller: 'LeadOnco',
      hash: txHash,
      status: receipt.status,
      executionResult: receipt.executionResult,
      returnOrError: receipt.returnReadable,
      votes: receipt.votes,
      expected: 'AUDIT_REJECTED:onco_escalate:SCOPE_ESCALATION',
      expectedFailure: false,
      readBack: { mandate, oncoAvailableAfter: oncoNode.available_budget, accounting }
    });
  }

  // S10: LeadOnco proposes valid Level-2 onco_pet (250 wei)
  if (!history.find(h => h.step === 'S10')) {
    console.log('\n--- S10: LeadOnco proposes valid Level-2 onco_pet (250 wei) ---');
    const { txHash, receipt } = await safeWrite(clients.leadOnco, {
      address: MAIN_ADDR,
      functionName: 'propose_mandate',
      args: ['onco', 'onco_pet', accounts.subPet.address, 250, SCOPES.onco_pet, EVIDENCES['onco_pet_charter.json'].url, EVIDENCES['onco_pet_charter.json'].hash],
      expectSuccess: true
    });
    assertExpectedReturn('S10', receipt.returnReadable, 'PROPOSED:onco_pet:PARENT_onco');
    const accounting = await readAccounting();
    recordStep({
      step: 'S10',
      scenario: 'Propose Valid Level-2 Mandate onco_pet (250 wei Reserved)',
      method: 'propose_mandate',
      caller: 'LeadOnco',
      hash: txHash,
      status: receipt.status,
      executionResult: receipt.executionResult,
      returnOrError: receipt.returnReadable,
      votes: receipt.votes,
      expected: 'PROPOSED:onco_pet:PARENT_onco',
      expectedFailure: false,
      readBack: { accounting }
    });
  }

  // S11: Audit onco_pet -> APPROVED (3-level delegation active!)
  if (!history.find(h => h.step === 'S11')) {
    console.log('\n--- S11: Audit Level-2 mandate onco_pet (Expected APPROVED) ---');
    const { txHash, receipt } = await safeWrite(clients.subPet, {
      address: MAIN_ADDR,
      functionName: 'audit_mandate',
      args: ['onco_pet'],
      expectSuccess: true
    });
    assertExpectedReturn('S11', receipt.returnReadable, 'AUDIT_APPROVED:onco_pet:SUBSUMED_AND_EXCLUSIVE');
    const mandate = await readMandate('onco_pet');
    const accounting = await readAccounting();
    recordStep({
      step: 'S11',
      scenario: 'LLM Consensus Audit: Level-2 onco_pet Approved (Depth 2 Active)',
      method: 'audit_mandate',
      caller: 'SubPet',
      hash: txHash,
      status: receipt.status,
      executionResult: receipt.executionResult,
      returnOrError: receipt.returnReadable,
      votes: receipt.votes,
      expected: 'AUDIT_APPROVED:onco_pet:SUBSUMED_AND_EXCLUSIVE',
      expectedFailure: false,
      readBack: { mandate, accounting }
    });
  }

  // S12: LeadOnco proposes Level-2 onco_pending (150 wei, held PENDING_AUDIT for BFS sweep)
  if (!history.find(h => h.step === 'S12')) {
    console.log('\n--- S12: LeadOnco proposes Level-2 onco_pending (150 wei, PENDING_AUDIT) ---');
    const { txHash, receipt } = await safeWrite(clients.leadOnco, {
      address: MAIN_ADDR,
      functionName: 'propose_mandate',
      args: ['onco', 'onco_pending', accounts.subBiopsy.address, 150, SCOPES.onco_pending, EVIDENCES['onco_charter.json'].url, EVIDENCES['onco_charter.json'].hash],
      expectSuccess: true
    });
    assertExpectedReturn('S12', receipt.returnReadable, 'PROPOSED:onco_pending:PARENT_onco');
    const mandate = await readMandate('onco_pending');
    const accounting = await readAccounting();
    recordStep({
      step: 'S12',
      scenario: 'Propose Level-2 onco_pending (150 wei Held in PENDING_AUDIT)',
      method: 'propose_mandate',
      caller: 'LeadOnco',
      hash: txHash,
      status: receipt.status,
      executionResult: receipt.executionResult,
      returnOrError: receipt.returnReadable,
      votes: receipt.votes,
      expected: 'PROPOSED:onco_pending:PARENT_onco',
      expectedFailure: false,
      readBack: { mandate, accounting }
    });
  }

  // X5: Attacker attempts execute_milestone on onco_pet
  if (!history.find(h => h.step === 'X5')) {
    console.log('\n--- X5: Attacker execute_milestone blocked ---');
    const { txHash, receipt } = await safeWrite(clients.attacker, {
      address: MAIN_ADDR,
      functionName: 'execute_milestone',
      args: ['onco_pet', 50, 'Unauthorized drawdown attempt'],
      expectSuccess: false
    });
    recordStep({
      step: 'X5',
      scenario: 'Untrusted Caller Treasury Draw Blocked',
      method: 'execute_milestone',
      caller: 'Attacker',
      hash: txHash,
      status: receipt.status,
      executionResult: receipt.executionResult,
      returnOrError: receipt.returnReadable || receipt.stderr,
      votes: receipt.votes,
      expected: 'UNAUTHORIZED_DELEGATEE',
      expectedFailure: true
    });
  }

  // S13: SubPet executes milestone of 50 wei on onco_pet
  if (!history.find(h => h.step === 'S13')) {
    console.log('\n--- S13: SubPet executes milestone (50 wei on onco_pet) ---');
    const { txHash, receipt } = await safeWrite(clients.subPet, {
      address: MAIN_ADDR,
      functionName: 'execute_milestone',
      args: ['onco_pet', 50, 'Completed EU Phase-II PET-CT biomarker assay milestone'],
      expectSuccess: true
    });
    assertExpectedReturn('S13', receipt.returnReadable, 'MILESTONE_EXECUTED:onco_pet:AMOUNT_50');
    const mandate = await readMandate('onco_pet');
    const pendingSubPet = Number(await readContractWithRetry(clients.root, {
      address: MAIN_ADDR,
      functionName: 'get_pending_payout',
      args: [accounts.subPet.address]
    }));
    const accounting = await readAccounting();
    recordStep({
      step: 'S13',
      scenario: 'Authorized Level-2 Milestone Drawdown (50 wei)',
      method: 'execute_milestone',
      caller: 'SubPet',
      hash: txHash,
      status: receipt.status,
      executionResult: receipt.executionResult,
      returnOrError: receipt.returnReadable,
      votes: receipt.votes,
      expected: 'MILESTONE_EXECUTED:onco_pet:AMOUNT_50',
      expectedFailure: false,
      readBack: { mandate, pendingPayoutSubPet: pendingSubPet, accounting }
    });
  }

  // S14: Compliant breach audit on onco -> COMPLIANT:WITHIN_SCOPE (subtree untouched!)
  if (!history.find(h => h.step === 'S14')) {
    console.log('\n--- S14: Compliant breach audit on onco (Expected BREACH_COMPLIANT) ---');
    const { txHash, receipt } = await safeWrite(clients.attacker, {
      address: MAIN_ADDR,
      functionName: 'audit_breach',
      args: ['onco', EVIDENCES['breach_compliant_audit.json'].url, EVIDENCES['breach_compliant_audit.json'].hash],
      expectSuccess: true
    });
    assertExpectedReturn('S14', receipt.returnReadable, 'BREACH_COMPLIANT:onco:WITHIN_SCOPE');
    const breachRaw = await readContractWithRetry(clients.root, {
      address: MAIN_ADDR,
      functionName: 'get_breach_audit',
      args: ['onco', EVIDENCES['breach_compliant_audit.json'].hash]
    });
    const oncoNode = await readMandate('onco');
    const accounting = await readAccounting();
    recordStep({
      step: 'S14',
      scenario: 'Strict Breach Polarity: Compliant Evidence Leaves Subtree Untouched',
      method: 'audit_breach',
      caller: 'Attacker',
      hash: txHash,
      status: receipt.status,
      executionResult: receipt.executionResult,
      returnOrError: receipt.returnReadable,
      votes: receipt.votes,
      expected: 'BREACH_COMPLIANT:onco:WITHIN_SCOPE',
      expectedFailure: false,
      readBack: { breachAudit: JSON.parse(breachRaw), oncoStatus: oncoNode.status, accounting }
    });
  }

  // X6: Replay identical concluded compliant breach snapshot blocked
  if (!history.find(h => h.step === 'X6')) {
    console.log('\n--- X6: Replay of concluded COMPLIANT breach snapshot blocked ---');
    const { txHash, receipt } = await safeWrite(clients.attacker, {
      address: MAIN_ADDR,
      functionName: 'audit_breach',
      args: ['onco', EVIDENCES['breach_compliant_audit.json'].url, EVIDENCES['breach_compliant_audit.json'].hash],
      expectSuccess: false
    });
    recordStep({
      step: 'X6',
      scenario: 'Conclusive COMPLIANT Breach Replay Blocked (Immutability)',
      method: 'audit_breach',
      caller: 'Attacker',
      hash: txHash,
      status: receipt.status,
      executionResult: receipt.executionResult,
      returnOrError: receipt.returnReadable || receipt.stderr,
      votes: receipt.votes,
      expected: 'BREACH_ALREADY_EVALUATED',
      expectedFailure: true
    });
  }

  // S15: Affirmative breach audit on onco -> BFS Cascade Revocation of 3 nodes, 550 wei reclaimed!
  if (!history.find(h => h.step === 'S15')) {
    console.log('\n--- S15: Affirmative breach audit on onco (Expected BREACH_REVOKED NODES_3 RECLAIMED_550) ---');
    const { txHash, receipt } = await safeWrite(clients.root, {
      address: MAIN_ADDR,
      functionName: 'audit_breach',
      args: ['onco', EVIDENCES['breach_violation_incident.json'].url, EVIDENCES['breach_violation_incident.json'].hash],
      expectSuccess: true
    });
    assertExpectedReturn('S15', receipt.returnReadable, 'BREACH_REVOKED:onco:NODES_3:RECLAIMED_550');
    const breachRaw = await readContractWithRetry(clients.root, {
      address: MAIN_ADDR,
      functionName: 'get_breach_audit',
      args: ['onco', EVIDENCES['breach_violation_incident.json'].hash]
    });
    const rootNode = await readMandate('root');
    const oncoNode = await readMandate('onco');
    const oncoPetNode = await readMandate('onco_pet');
    const oncoPendingNode = await readMandate('onco_pending');
    const radioNode = await readMandate('radio');
    const accounting = await readAccounting();
    recordStep({
      step: 'S15',
      scenario: 'Affirmative Breach BFS Cascade Revocation (3 Nodes Revoked, 550 wei Rolled Back to Root; Sibling radio Untouched)',
      method: 'audit_breach',
      caller: 'Root',
      hash: txHash,
      status: receipt.status,
      executionResult: receipt.executionResult,
      returnOrError: receipt.returnReadable,
      votes: receipt.votes,
      expected: 'BREACH_REVOKED:onco:NODES_3:RECLAIMED_550',
      expectedFailure: false,
      readBack: {
        breachAudit: JSON.parse(breachRaw),
        rootAvailable: rootNode.available_budget,
        statuses: {
          onco: oncoNode.status,
          onco_pet: oncoPetNode.status,
          onco_pending: oncoPendingNode.status,
          radio: radioNode.status
        },
        radioAvailable: radioNode.available_budget,
        accounting
      }
    });
  }

  // X7: SubPet attempts execute_milestone after cascade revocation
  if (!history.find(h => h.step === 'X7')) {
    console.log('\n--- X7: Cascade-revoked descendant execute_milestone blocked ---');
    const { txHash, receipt } = await safeWrite(clients.subPet, {
      address: MAIN_ADDR,
      functionName: 'execute_milestone',
      args: ['onco_pet', 10, 'Post-revocation draw'],
      expectSuccess: false
    });
    recordStep({
      step: 'X7',
      scenario: 'Cascade-Revoked Descendant Milestone Draw Blocked',
      method: 'execute_milestone',
      caller: 'SubPet',
      hash: txHash,
      status: receipt.status,
      executionResult: receipt.executionResult,
      returnOrError: receipt.returnReadable || receipt.stderr,
      votes: receipt.votes,
      expected: 'MANDATE_NOT_ACTIVE',
      expectedFailure: true
    });
  }

  // X8: LeadOnco attempts propose_mandate under revoked onco
  if (!history.find(h => h.step === 'X8')) {
    console.log('\n--- X8: Revoked branch sub-delegation blocked ---');
    const { txHash, receipt } = await safeWrite(clients.leadOnco, {
      address: MAIN_ADDR,
      functionName: 'propose_mandate',
      args: ['onco', 'onco_new', accounts.subPet.address, 10, SCOPES.onco_pet, EVIDENCES['onco_pet_charter.json'].url, EVIDENCES['onco_pet_charter.json'].hash],
      expectSuccess: false
    });
    recordStep({
      step: 'X8',
      scenario: 'Revoked Branch Sub-Delegation Blocked',
      method: 'propose_mandate',
      caller: 'LeadOnco',
      hash: txHash,
      status: receipt.status,
      executionResult: receipt.executionResult,
      returnOrError: receipt.returnReadable || receipt.stderr,
      votes: receipt.votes,
      expected: 'PARENT_NOT_ACTIVE',
      expectedFailure: true
    });
  }

  // X9: Attacker attempts premature sweep_expired_tree before deadline
  if (!history.find(h => h.step === 'X9')) {
    console.log('\n--- X9: Premature sweep_expired_tree blocked ---');
    const { txHash, receipt } = await safeWrite(clients.attacker, {
      address: MAIN_ADDR,
      functionName: 'sweep_expired_tree',
      args: [],
      expectSuccess: false
    });
    recordStep({
      step: 'X9',
      scenario: 'Premature Expiry Sweep Before Deadline Blocked',
      method: 'sweep_expired_tree',
      caller: 'Attacker',
      hash: txHash,
      status: receipt.status,
      executionResult: receipt.executionResult,
      returnOrError: receipt.returnReadable || receipt.stderr,
      votes: receipt.votes,
      expected: 'TREE_STILL_ACTIVE',
      expectedFailure: true
    });
  }

  // S16: LeadRadio (unaffected sibling!) executes milestone of 100 wei
  if (!history.find(h => h.step === 'S16')) {
    console.log('\n--- S16: Unaffected sibling radio executes milestone (100 wei) ---');
    const { txHash, receipt } = await safeWrite(clients.leadRadio, {
      address: MAIN_ADDR,
      functionName: 'execute_milestone',
      args: ['radio', 100, 'Completed APAC MRI/CT hardware calibration QA'],
      expectSuccess: true
    });
    assertExpectedReturn('S16', receipt.returnReadable, 'MILESTONE_EXECUTED:radio:AMOUNT_100');
    const radioNode = await readMandate('radio');
    const pendingRadio = Number(await readContractWithRetry(clients.root, {
      address: MAIN_ADDR,
      functionName: 'get_pending_payout',
      args: [accounts.leadRadio.address]
    }));
    const accounting = await readAccounting();
    recordStep({
      step: 'S16',
      scenario: 'Sibling Isolation Proven: Unaffected radio Executes Milestone (100 wei)',
      method: 'execute_milestone',
      caller: 'LeadRadio',
      hash: txHash,
      status: receipt.status,
      executionResult: receipt.executionResult,
      returnOrError: receipt.returnReadable,
      votes: receipt.votes,
      expected: 'MILESTONE_EXECUTED:radio:AMOUNT_100',
      expectedFailure: false,
      readBack: { radioAvailable: radioNode.available_budget, pendingPayoutLeadRadio: pendingRadio, accounting }
    });
  }

  // S17: SubPet withdraws 50 wei real native payout via _EoaRecipient.emit_transfer
  if (!history.find(h => h.step === 'S17')) {
    console.log('\n--- S17: SubPet withdraws 50 wei real native payout ---');
    const balBeforeHex = await rawRpcCall('eth_getBalance', [accounts.subPet.address, 'latest']);
    const balBefore = BigInt(balBeforeHex || '0x0');
    const { txHash, receipt } = await safeWrite(clients.subPet, {
      address: MAIN_ADDR,
      functionName: 'withdraw_payout',
      args: [],
      expectSuccess: true
    });
    if (String(receipt.returnReadable) !== '50') {
      throw new Error(`STOP: Step S17 expected return 50, got ${receipt.returnReadable}`);
    }
    const balAfterHex = await rawRpcCall('eth_getBalance', [accounts.subPet.address, 'latest']);
    const balAfter = BigInt(balAfterHex || '0x0');
    const pendingAfter = Number(await readContractWithRetry(clients.root, {
      address: MAIN_ADDR,
      functionName: 'get_pending_payout',
      args: [accounts.subPet.address]
    }));
    const accounting = await readAccounting();
    recordStep({
      step: 'S17',
      scenario: 'Pull-Payment Real Native Withdrawal via _EoaRecipient.emit_transfer (50 wei)',
      method: 'withdraw_payout',
      caller: 'SubPet',
      hash: txHash,
      status: receipt.status,
      executionResult: receipt.executionResult,
      returnOrError: receipt.returnReadable,
      votes: receipt.votes,
      expected: '50',
      expectedFailure: false,
      readBack: {
        subPetBalanceBeforeWei: balBefore.toString(),
        subPetBalanceAfterWei: balAfter.toString(),
        subPetNativeDeltaWei: (balAfter - balBefore).toString(),
        subPetPendingAfter: pendingAfter,
        accounting
      }
    });
  }

  console.log('\n===============================================================');
  console.log('  MandateTree Live StudioNet Demo Complete! (S1-S17 & X1-X9)   ');
  console.log(`  Manifest written to: ${MANIFEST_FILE}`);
  console.log('===============================================================');
}

main().catch(err => {
  console.error('\n[FATAL ERROR]:', err);
  process.exit(1);
});
