import hashlib
import json
from pathlib import Path
import pytest

from contracts.mandate_tree import (
    MandateTree,
    MAX_AUDIT_ATTEMPTS,
    MAX_CHILDREN_PER_NODE,
    MAX_DEPTH,
    MAX_EVIDENCE_BYTES,
    MAX_MILESTONES,
    MAX_TOTAL_MANDATES,
    ZERO_ADDRESS,
    enforce_breach_verdict_compatibility,
    enforce_mandate_verdict_compatibility,
    is_compatible_breach_verdict_reason,
    is_compatible_mandate_verdict_reason,
    is_valid_address,
    is_valid_evidence_url,
    is_valid_mandate_id,
    is_valid_sha256_hex,
    validate_breach_leader_response,
    validate_mandate_leader_response,
)
from conftest import (
    ADDR_ATTACKER,
    ADDR_LEAD_ONCO,
    ADDR_LEAD_RADIO,
    ADDR_ROOT,
    ADDR_SUB_BIOPSY,
    ADDR_SUB_DEEP3,
    ADDR_SUB_DEEP4,
    ADDR_SUB_PET,
    MockWebResponse,
    UserError,
    emitted_transfers,
    gl_mock,
    mock_llm_responses,
    mock_web_responses,
    set_sender,
    set_time,
    set_value,
)

EVIDENCE_DIR = Path(__file__).resolve().parent.parent / "evidence"
COMMIT_SHA = "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2"
BASE_URL = f"https://raw.githubusercontent.com/Kanezar3/MandateTree/{COMMIT_SHA}/evidence"

URL_ROOT = f"{BASE_URL}/root_charter.json"
URL_ONCO = f"{BASE_URL}/onco_charter.json"
URL_RADIO = f"{BASE_URL}/radio_charter.json"
URL_ONCO_DUP = f"{BASE_URL}/onco_dup_charter.json"
URL_ONCO_ESCALATE = f"{BASE_URL}/onco_escalate_charter.json"
URL_ONCO_PET = f"{BASE_URL}/onco_pet_charter.json"
URL_BREACH_OK = f"{BASE_URL}/breach_compliant_audit.json"
URL_BREACH_BAD = f"{BASE_URL}/breach_violation_incident.json"

SCOPE_ROOT = "Global Clinical Genomics & Trial Oversight across EU, North America, and APAC (non-commercial research and imaging audits only; zero commercial advertising)"
SCOPE_ONCO = "EU/NA Phase-II Oncology Biomarker Analysis (PET-CT and liquid biopsy academic research only; no APAC, no hardware audits, no commercial marketing)"
SCOPE_RADIO = "APAC Medical Imaging & Radiology Hardware Audit (MRI/CT calibration and radiation safety in APAC only; no EU/NA, no oncology biomarkers)"
SCOPE_ONCO_DUP = "EU/NA Phase-II Oncology Biomarker Analysis (duplicate EU/NA oncology biomarker research)"
SCOPE_ONCO_ESCALATE = "Global Commercial Pharmaceutical Retail Marketing & Direct-to-Consumer TV Advertising"
SCOPE_ONCO_PET = "EU Phase-II PET-CT Oncology Biomarker Assay & Academic Statistical Analysis (EU sites only)"
SCOPE_ONCO_PENDING = "North America Phase-II Liquid Biopsy Biomarker Assay Standardization (NA sites only)"


def _read_fixture(filename: str) -> bytes:
    return (EVIDENCE_DIR / filename).read_bytes()


def _sha256(b: bytes) -> str:
    return hashlib.sha256(b).hexdigest()


def _extract_tag(prompt: str, tag: str) -> str:
    s = f"<{tag}>"
    e = f"</{tag}>"
    if s in prompt and e in prompt:
        return prompt.split(s, 1)[1].split(e, 1)[0].strip()
    return ""


def _assert_conservation(contract: MandateTree) -> dict:
    acct = json.loads(contract.get_accounting_summary())
    assert acct["tree_conservation_ok"] is True, f"Tree conservation failed: {acct}"
    assert acct["payout_conservation_ok"] is True, f"Payout conservation failed: {acct}"
    assert acct["conservation_ok"] is True, f"Accounting conservation failed: {acct}"
    return acct


def _load_standard_fixtures() -> dict[str, str]:
    files = {
        "root": ("root_charter.json", URL_ROOT),
        "onco": ("onco_charter.json", URL_ONCO),
        "radio": ("radio_charter.json", URL_RADIO),
        "onco_dup": ("onco_dup_charter.json", URL_ONCO_DUP),
        "onco_escalate": ("onco_escalate_charter.json", URL_ONCO_ESCALATE),
        "onco_pet": ("onco_pet_charter.json", URL_ONCO_PET),
        "breach_ok": ("breach_compliant_audit.json", URL_BREACH_OK),
        "breach_bad": ("breach_violation_incident.json", URL_BREACH_BAD),
    }
    hashes = {}
    for key, (fname, url) in files.items():
        raw = _read_fixture(fname)
        assert b"\r" not in raw
        assert 1 <= len(raw) < 900
        mock_web_responses[url] = MockWebResponse(status=200, body=raw)
        hashes[key] = _sha256(raw)
    return hashes


def _install_standard_llm():
    def handler(prompt: str) -> dict:
        if "<UNTRUSTED_BREACH_EVIDENCE>" in prompt:
            ev = _extract_tag(prompt, "UNTRUSTED_BREACH_EVIDENCE")
            if '"violation_detected": true' in ev:
                return {"verdict": "BREACH_CONFIRMED", "reason": "VIOLATION_PROVEN"}
            return {"verdict": "COMPLIANT", "reason": "WITHIN_SCOPE"}

        parent_scope = _extract_tag(prompt, "PARENT_SCOPE")
        child_scope = _extract_tag(prompt, "CHILD_SCOPE")
        siblings = _extract_tag(prompt, "ACTIVE_SIBLINGS")

        if "Commercial Pharmaceutical Retail Marketing" in child_scope:
            return {
                "subsumed_by_parent": False,
                "exclusive_from_siblings": True,
                "verdict": "REJECTED",
                "reason": "SCOPE_ESCALATION",
            }
        if "Oncology Biomarker" in child_scope and "Oncology Biomarker" in siblings:
            return {
                "subsumed_by_parent": True,
                "exclusive_from_siblings": False,
                "verdict": "REJECTED",
                "reason": "SIBLING_OVERLAP",
            }
        if "EU/NA Phase-II Oncology" in child_scope and "Global Clinical Genomics" in parent_scope:
            return {
                "subsumed_by_parent": True,
                "exclusive_from_siblings": True,
                "verdict": "APPROVED",
                "reason": "SUBSUMED_AND_EXCLUSIVE",
            }
        if "APAC Medical Imaging" in child_scope and "Global Clinical Genomics" in parent_scope:
            return {
                "subsumed_by_parent": True,
                "exclusive_from_siblings": True,
                "verdict": "APPROVED",
                "reason": "SUBSUMED_AND_EXCLUSIVE",
            }
        if "EU Phase-II PET-CT Oncology" in child_scope and "EU/NA Phase-II Oncology" in parent_scope:
            return {
                "subsumed_by_parent": True,
                "exclusive_from_siblings": True,
                "verdict": "APPROVED",
                "reason": "SUBSUMED_AND_EXCLUSIVE",
            }
        return {
            "subsumed_by_parent": True,
            "exclusive_from_siblings": True,
            "verdict": "APPROVED",
            "reason": "SUBSUMED_AND_EXCLUSIVE",
        }

    mock_llm_responses.clear()
    mock_llm_responses.append(handler)


# =============================================================================
# 1. Full 3-Level Clinical Grant Happy Path, Sibling Exclusivity & BFS Cascade
# =============================================================================
def test_full_3_level_clinical_grant_happy_path_and_bfs_cascade():
    hashes = _load_standard_fixtures()
    _install_standard_llm()

    set_sender(ADDR_ROOT)
    set_time(1794900000)
    contract = MandateTree()

    # X1: Unauthorized initialize_tree
    set_sender(ADDR_ATTACKER)
    set_value(1000)
    with pytest.raises(UserError, match="UNAUTHORIZED_CALLER"):
        contract.initialize_tree(1000, 3600, SCOPE_ROOT, URL_ROOT, hashes["root"])

    # S1: Root initializes tree with real native value == 1000
    set_sender(ADDR_ROOT)
    set_value(1000)
    assert contract.initialize_tree(1000, 3600, SCOPE_ROOT, URL_ROOT, hashes["root"]) == "TREE_INITIALIZED:root"
    set_value(0)
    _assert_conservation(contract)

    # X2: Unpinned /main/ URL rejected
    with pytest.raises(UserError, match="INVALID_EVIDENCE_URL"):
        contract.propose_mandate(
            "root",
            "onco",
            ADDR_LEAD_ONCO,
            600,
            SCOPE_ONCO,
            "https://raw.githubusercontent.com/Kanezar3/MandateTree/main/evidence/onco_charter.json",
            hashes["onco"],
        )

    # X3: Unauthorized delegator rejected
    set_sender(ADDR_ATTACKER)
    with pytest.raises(UserError, match="UNAUTHORIZED_DELEGATOR"):
        contract.propose_mandate("root", "onco", ADDR_LEAD_ONCO, 600, SCOPE_ONCO, URL_ONCO, hashes["onco"])

    # S2 & S3: Propose and approve Level-1 mandate "onco" (600)
    set_sender(ADDR_ROOT)
    assert contract.propose_mandate("root", "onco", ADDR_LEAD_ONCO, 600, SCOPE_ONCO, URL_ONCO, hashes["onco"]) == "PROPOSED:onco:PARENT_root"
    assert json.loads(contract.get_mandate("root"))["available_budget"] == 400
    _assert_conservation(contract)

    set_sender(ADDR_LEAD_ONCO)
    assert contract.audit_mandate("onco") == "AUDIT_APPROVED:onco:SUBSUMED_AND_EXCLUSIVE"
    onco_node = json.loads(contract.get_mandate("onco"))
    assert onco_node["status"] == "ACTIVE"
    assert onco_node["available_budget"] == 600
    assert onco_node["attempts"] == 1
    _assert_conservation(contract)

    # X4: Conclusive APPROVED immutability
    set_sender(ADDR_ATTACKER)
    with pytest.raises(UserError, match="MANDATE_ALREADY_CONCLUDED"):
        contract.audit_mandate("onco")

    # S4 & S5: Propose and approve disjoint sibling "radio" (300)
    set_sender(ADDR_ROOT)
    assert contract.propose_mandate("root", "radio", ADDR_LEAD_RADIO, 300, SCOPE_RADIO, URL_RADIO, hashes["radio"]) == "PROPOSED:radio:PARENT_root"
    assert json.loads(contract.get_mandate("root"))["available_budget"] == 100
    _assert_conservation(contract)

    set_sender(ADDR_LEAD_RADIO)
    assert contract.audit_mandate("radio") == "AUDIT_APPROVED:radio:SUBSUMED_AND_EXCLUSIVE"
    _assert_conservation(contract)

    # S6 & S7: Overlapping sibling "onco_dup" (50) rejected with SIBLING_OVERLAP + auto-refund
    set_sender(ADDR_ROOT)
    assert contract.propose_mandate("root", "onco_dup", ADDR_ATTACKER, 50, SCOPE_ONCO_DUP, URL_ONCO_DUP, hashes["onco_dup"]) == "PROPOSED:onco_dup:PARENT_root"
    assert json.loads(contract.get_mandate("root"))["available_budget"] == 50
    _assert_conservation(contract)

    assert contract.audit_mandate("onco_dup") == "AUDIT_REJECTED:onco_dup:SIBLING_OVERLAP"
    assert json.loads(contract.get_mandate("onco_dup"))["status"] == "REJECTED"
    assert json.loads(contract.get_mandate("root"))["available_budget"] == 100
    _assert_conservation(contract)

    # S8 & S9: Level-2 scope escalation "onco_escalate" (50) under onco rejected + auto-refund
    set_sender(ADDR_LEAD_ONCO)
    assert contract.propose_mandate("onco", "onco_escalate", ADDR_SUB_PET, 50, SCOPE_ONCO_ESCALATE, URL_ONCO_ESCALATE, hashes["onco_escalate"]) == "PROPOSED:onco_escalate:PARENT_onco"
    assert json.loads(contract.get_mandate("onco"))["available_budget"] == 550
    _assert_conservation(contract)

    assert contract.audit_mandate("onco_escalate") == "AUDIT_REJECTED:onco_escalate:SCOPE_ESCALATION"
    assert json.loads(contract.get_mandate("onco"))["available_budget"] == 600
    _assert_conservation(contract)

    # S10 & S11: Valid Level-2 child "onco_pet" (250) under onco approved (depth=2)
    assert contract.propose_mandate("onco", "onco_pet", ADDR_SUB_PET, 250, SCOPE_ONCO_PET, URL_ONCO_PET, hashes["onco_pet"]) == "PROPOSED:onco_pet:PARENT_onco"
    assert json.loads(contract.get_mandate("onco"))["available_budget"] == 350
    set_sender(ADDR_SUB_PET)
    assert contract.audit_mandate("onco_pet") == "AUDIT_APPROVED:onco_pet:SUBSUMED_AND_EXCLUSIVE"
    pet_node = json.loads(contract.get_mandate("onco_pet"))
    assert pet_node["depth"] == 2
    assert pet_node["status"] == "ACTIVE"
    _assert_conservation(contract)

    # S12: Level-2 PENDING_AUDIT child "onco_pending" (150) under onco
    set_sender(ADDR_LEAD_ONCO)
    assert contract.propose_mandate("onco", "onco_pending", ADDR_SUB_BIOPSY, 150, SCOPE_ONCO_PENDING, URL_ONCO_PET, hashes["onco_pet"]) == "PROPOSED:onco_pending:PARENT_onco"
    assert json.loads(contract.get_mandate("onco"))["available_budget"] == 200
    _assert_conservation(contract)

    # X5: Untrusted caller cannot draw milestone on onco_pet
    set_sender(ADDR_ATTACKER)
    with pytest.raises(UserError, match="UNAUTHORIZED_DELEGATEE"):
        contract.execute_milestone("onco_pet", 50, "Unauthorized draw")

    # S13: Authorized drawdown by SubPet (50)
    set_sender(ADDR_SUB_PET)
    assert contract.execute_milestone("onco_pet", 50, "EU PET-CT milestone 1 completed") == "MILESTONE_EXECUTED:onco_pet:AMOUNT_50"
    assert json.loads(contract.get_mandate("onco_pet"))["available_budget"] == 200
    assert contract.get_pending_payout(ADDR_SUB_PET) == 50
    _assert_conservation(contract)

    # S14: Compliant breach check leaves subtree completely untouched
    set_sender(ADDR_ATTACKER)
    assert contract.audit_breach("onco", URL_BREACH_OK, hashes["breach_ok"]) == "BREACH_COMPLIANT:onco:WITHIN_SCOPE"
    assert json.loads(contract.get_mandate("onco"))["status"] == "ACTIVE"
    assert json.loads(contract.get_mandate("onco_pet"))["status"] == "ACTIVE"
    assert json.loads(contract.get_mandate("onco_pending"))["status"] == "PENDING_AUDIT"
    _assert_conservation(contract)

    # X6: Conclusive COMPLIANT breach snapshot is immutable
    with pytest.raises(UserError, match="BREACH_ALREADY_EVALUATED"):
        contract.audit_breach("onco", URL_BREACH_OK, hashes["breach_ok"])

    # S15: Affirmative breach triggers deterministic BFS cascade over Subtree(onco)
    set_sender(ADDR_ROOT)
    res_breach = contract.audit_breach("onco", URL_BREACH_BAD, hashes["breach_bad"])
    assert res_breach == "BREACH_REVOKED:onco:NODES_3:RECLAIMED_550"

    for revoked_id in ("onco", "onco_pet", "onco_pending"):
        rec = json.loads(contract.get_mandate(revoked_id))
        assert rec["status"] == "REVOKED_CASCADE"
        assert rec["available_budget"] == 0
        assert rec["pending_reserved"] == 0
        assert rec["revoked_by_root"] == "onco"

    # Root reclaimed 200 (onco) + 200 (onco_pet) + 150 (onco_pending) = 550 -> root.avail = 650
    assert json.loads(contract.get_mandate("root"))["available_budget"] == 650
    # Sibling "radio" completely untouched!
    assert json.loads(contract.get_mandate("radio"))["status"] == "ACTIVE"
    assert json.loads(contract.get_mandate("radio"))["available_budget"] == 300
    _assert_conservation(contract)

    # X7: Revoked descendant cannot draw
    set_sender(ADDR_SUB_PET)
    with pytest.raises(UserError, match="MANDATE_NOT_ACTIVE"):
        contract.execute_milestone("onco_pet", 10, "Post-revocation draw")

    # X8: Revoked branch cannot sub-delegate
    set_sender(ADDR_LEAD_ONCO)
    with pytest.raises(UserError, match="PARENT_NOT_ACTIVE"):
        contract.propose_mandate("onco", "onco_new", ADDR_SUB_PET, 10, SCOPE_ONCO_PET, URL_ONCO_PET, hashes["onco_pet"])

    # X9: Premature sweep blocked
    set_sender(ADDR_ATTACKER)
    with pytest.raises(UserError, match="TREE_STILL_ACTIVE"):
        contract.sweep_expired_tree()

    # S16: Sibling isolation proven - LeadRadio draws milestone 100
    set_sender(ADDR_LEAD_RADIO)
    assert contract.execute_milestone("radio", 100, "APAC MRI calibration audit completed") == "MILESTONE_EXECUTED:radio:AMOUNT_100"
    assert json.loads(contract.get_mandate("radio"))["available_budget"] == 200
    _assert_conservation(contract)

    # S17: Real native value pull-payment withdrawal by SubPet (50)
    set_sender(ADDR_SUB_PET)
    assert contract.withdraw_payout() == 50
    assert contract.get_pending_payout(ADDR_SUB_PET) == 0
    assert len(emitted_transfers) == 1
    assert emitted_transfers[0]["to"] == ADDR_SUB_PET.as_hex.lower()
    assert emitted_transfers[0]["value"] == 50
    assert emitted_transfers[0]["mechanism"] == "_EoaRecipient"

    acct = _assert_conservation(contract)
    assert acct["root_budget"] == 1000
    assert acct["total_active_available"] == 850  # root 650 + radio 200
    assert acct["total_pending_reserved"] == 0
    assert acct["total_spent"] == 150  # SubPet 50 + LeadRadio 100
    assert acct["total_pending_payouts"] == 100  # LeadRadio 100
    assert acct["total_withdrawn"] == 50  # SubPet 50


# =============================================================================
# 2. Mandate & Breach Verdict Compatibility Tables
# =============================================================================
def test_mandate_and_breach_verdict_compatibility_tables():
    # Mandate compatibility valid cases
    assert is_compatible_mandate_verdict_reason(True, True, "APPROVED", "SUBSUMED_AND_EXCLUSIVE", True) is True
    assert is_compatible_mandate_verdict_reason(True, True, "APPROVED", "SUBSUMED_AND_EXCLUSIVE", False) is True
    assert is_compatible_mandate_verdict_reason(False, True, "REJECTED", "SCOPE_ESCALATION", False) is True
    assert is_compatible_mandate_verdict_reason(False, False, "REJECTED", "SCOPE_ESCALATION", True) is True
    assert is_compatible_mandate_verdict_reason(False, True, "REJECTED", "EVIDENCE_CONTRADICTS_SCOPE", False) is True
    assert is_compatible_mandate_verdict_reason(True, False, "REJECTED", "SIBLING_OVERLAP", True) is True
    assert is_compatible_mandate_verdict_reason(False, False, "UNVERIFIABLE", "FETCH_OR_PARSE_FAILURE", True) is True
    assert is_compatible_mandate_verdict_reason(False, False, "UNVERIFIABLE", "HASH_MISMATCH", False) is True

    # Mandate compatibility invalid / spoofed cases
    assert is_compatible_mandate_verdict_reason(1, True, "APPROVED", "SUBSUMED_AND_EXCLUSIVE", True) is False  # int vs bool
    assert is_compatible_mandate_verdict_reason(True, 1, "APPROVED", "SUBSUMED_AND_EXCLUSIVE", True) is False
    assert is_compatible_mandate_verdict_reason(False, True, "APPROVED", "SUBSUMED_AND_EXCLUSIVE", True) is False
    assert is_compatible_mandate_verdict_reason(True, False, "APPROVED", "SUBSUMED_AND_EXCLUSIVE", True) is False
    assert is_compatible_mandate_verdict_reason(True, True, "APPROVED", "SCOPE_ESCALATION", True) is False
    assert is_compatible_mandate_verdict_reason(True, False, "REJECTED", "SIBLING_OVERLAP", False) is False  # zero siblings!
    assert is_compatible_mandate_verdict_reason(False, False, "REJECTED", "SCOPE_ESCALATION", False) is False  # zero siblings must be exclusive=True
    assert is_compatible_mandate_verdict_reason(True, True, "REJECTED", "SCOPE_ESCALATION", True) is False
    assert is_compatible_mandate_verdict_reason(True, False, "UNVERIFIABLE", "FETCH_OR_PARSE_FAILURE", True) is False
    assert is_compatible_mandate_verdict_reason(False, False, "UNVERIFIABLE", "SUBSUMED_AND_EXCLUSIVE", True) is False

    # Enforce coercion rules
    assert enforce_mandate_verdict_compatibility(True, False, "APPROVED", "SUBSUMED_AND_EXCLUSIVE", has_active_siblings=False) == (True, True, "APPROVED", "SUBSUMED_AND_EXCLUSIVE")
    assert enforce_mandate_verdict_compatibility(True, False, "APPROVED", "SUBSUMED_AND_EXCLUSIVE", has_active_siblings=True) == (True, False, "REJECTED", "SIBLING_OVERLAP")
    assert enforce_mandate_verdict_compatibility(False, True, "APPROVED", "SUBSUMED_AND_EXCLUSIVE", has_active_siblings=True) == (False, True, "REJECTED", "SCOPE_ESCALATION")
    assert enforce_mandate_verdict_compatibility(True, True, "APPROVED", "SCOPE_ESCALATION", has_active_siblings=True) == (False, True, "REJECTED", "SCOPE_ESCALATION")
    assert enforce_mandate_verdict_compatibility(True, True, "APPROVED", "SIBLING_OVERLAP", has_active_siblings=True) == (True, False, "REJECTED", "SIBLING_OVERLAP")
    assert enforce_mandate_verdict_compatibility(True, True, "APPROVED", "SIBLING_OVERLAP", has_active_siblings=False) == (False, False, "UNVERIFIABLE", "FETCH_OR_PARSE_FAILURE")
    assert enforce_mandate_verdict_compatibility(True, False, "REJECTED", "SIBLING_OVERLAP", has_active_siblings=False) == (False, True, "REJECTED", "SCOPE_ESCALATION")
    assert enforce_mandate_verdict_compatibility(True, True, "REJECTED", "SUBSUMED_AND_EXCLUSIVE", has_active_siblings=True) == (False, True, "REJECTED", "SCOPE_ESCALATION")
    assert enforce_mandate_verdict_compatibility(True, True, "GARBAGE", "WHATEVER", has_active_siblings=True) == (False, False, "UNVERIFIABLE", "FETCH_OR_PARSE_FAILURE")

    # Breach compatibility & strict affirmative polarity
    assert is_compatible_breach_verdict_reason("BREACH_CONFIRMED", "VIOLATION_PROVEN") is True
    assert is_compatible_breach_verdict_reason("COMPLIANT", "WITHIN_SCOPE") is True
    assert is_compatible_breach_verdict_reason("UNVERIFIABLE", "FETCH_OR_PARSE_FAILURE") is True
    assert is_compatible_breach_verdict_reason("UNVERIFIABLE", "HASH_MISMATCH") is True
    assert is_compatible_breach_verdict_reason("BREACH_CONFIRMED", "WITHIN_SCOPE") is False
    assert is_compatible_breach_verdict_reason("COMPLIANT", "VIOLATION_PROVEN") is False
    assert is_compatible_breach_verdict_reason("UNVERIFIABLE", "VIOLATION_PROVEN") is False

    assert enforce_breach_verdict_compatibility("BREACH_CONFIRMED", "VIOLATION_PROVEN") == ("BREACH_CONFIRMED", "VIOLATION_PROVEN")
    assert enforce_breach_verdict_compatibility("BREACH_CONFIRMED", "WITHIN_SCOPE") == ("COMPLIANT", "WITHIN_SCOPE")
    assert enforce_breach_verdict_compatibility("BREACH_CONFIRMED", "UNKNOWN") == ("UNVERIFIABLE", "FETCH_OR_PARSE_FAILURE")
    assert enforce_breach_verdict_compatibility("COMPLIANT", "VIOLATION_PROVEN") == ("COMPLIANT", "WITHIN_SCOPE")
    assert enforce_breach_verdict_compatibility("COMPLIANT", "HASH_MISMATCH") == ("UNVERIFIABLE", "HASH_MISMATCH")
    assert enforce_breach_verdict_compatibility("UNKNOWN", "VIOLATION_PROVEN") == ("UNVERIFIABLE", "FETCH_OR_PARSE_FAILURE")


# =============================================================================
# 3. Adversarial Leader Direct & On-Chain Consensus Rejection
# =============================================================================
def test_adversarial_leader_direct_and_on_chain_rejection():
    valid_m = {
        "evidence_digest": "a" * 64,
        "exclusive_from_siblings": True,
        "mandate_id": "onco",
        "parent_id": "root",
        "reason": "SUBSUMED_AND_EXCLUSIVE",
        "subsumed_by_parent": True,
        "verdict": "APPROVED",
    }
    assert validate_mandate_leader_response(valid_m, dict(valid_m), has_active_siblings=True) is True

    # Direct attacks on validate_mandate_leader_response
    assert validate_mandate_leader_response(dict(valid_m, reason="SCOPE_ESCALATION"), valid_m, True) is False
    assert validate_mandate_leader_response(dict(valid_m, evidence_digest="b" * 64), valid_m, True) is False
    assert validate_mandate_leader_response(dict(valid_m, subsumed_by_parent=False), valid_m, True) is False
    assert validate_mandate_leader_response(dict(valid_m, extra="injected"), valid_m, True) is False
    missing_key = dict(valid_m)
    missing_key.pop("parent_id")
    assert validate_mandate_leader_response(missing_key, valid_m, True) is False
    # Python True == 1 type spoofing must fail!
    spoof_int = dict(valid_m, subsumed_by_parent=1)
    assert validate_mandate_leader_response(spoof_int, valid_m, True) is False
    assert validate_mandate_leader_response(spoof_int, spoof_int, True) is False
    # Incompatible pair rejected even if both leader and validator claim it
    bad_pair = dict(valid_m, verdict="APPROVED", reason="SIBLING_OVERLAP")
    assert validate_mandate_leader_response(bad_pair, bad_pair, True) is False

    # Direct attacks on validate_breach_leader_response
    valid_b = {
        "breach_digest": "c" * 64,
        "expected_hash": "c" * 64,
        "mandate_id": "onco",
        "reason": "VIOLATION_PROVEN",
        "verdict": "BREACH_CONFIRMED",
    }
    assert validate_breach_leader_response(valid_b, dict(valid_b)) is True
    assert validate_breach_leader_response(dict(valid_b, breach_digest="d" * 64), valid_b) is False
    assert validate_breach_leader_response(dict(valid_b, verdict="COMPLIANT", reason="WITHIN_SCOPE"), valid_b) is False
    assert validate_breach_leader_response(dict(valid_b, extra=1), valid_b) is False
    bad_b = dict(valid_b, verdict="BREACH_CONFIRMED", reason="WITHIN_SCOPE")
    assert validate_breach_leader_response(bad_b, bad_b) is False

    # On-chain Byzantine leader rejection for both audit_mandate and audit_breach
    hashes = _load_standard_fixtures()
    _install_standard_llm()
    set_sender(ADDR_ROOT)
    set_value(1000)
    contract = MandateTree()
    contract.initialize_tree(1000, 3600, SCOPE_ROOT, URL_ROOT, hashes["root"])
    set_value(0)
    contract.propose_mandate("root", "onco", ADDR_LEAD_ONCO, 600, SCOPE_ONCO, URL_ONCO, hashes["onco"])

    # Byzantine leader tampers evidence_digest during audit_mandate
    gl_mock.adversarial_leader_fn = lambda res: dict(res, evidence_digest="f" * 64)
    with pytest.raises(UserError, match="CONSENSUS_VALIDATION_FAILED"):
        contract.audit_mandate("onco")
    # State remains unmutated (PENDING_AUDIT, attempts == 0)
    assert json.loads(contract.get_mandate("onco"))["status"] == "PENDING_AUDIT"
    assert json.loads(contract.get_mandate("onco"))["attempts"] == 0

    # Honest audit succeeds
    gl_mock.adversarial_leader_fn = None
    assert contract.audit_mandate("onco") == "AUDIT_APPROVED:onco:SUBSUMED_AND_EXCLUSIVE"

    # Byzantine leader tries to forge BREACH_CONFIRMED on a COMPLIANT audit
    gl_mock.adversarial_leader_fn = lambda res: dict(res, verdict="BREACH_CONFIRMED", reason="VIOLATION_PROVEN")
    with pytest.raises(UserError, match="CONSENSUS_VALIDATION_FAILED"):
        contract.audit_breach("onco", URL_BREACH_OK, hashes["breach_ok"])
    assert json.loads(contract.get_mandate("onco"))["status"] == "ACTIVE"
    _assert_conservation(contract)


# =============================================================================
# 4. Transient UNVERIFIABLE Retry Lifecycle & Conclusive Immutability
# =============================================================================
def test_unverifiable_retry_lifecycle_and_conclusive_immutability():
    hashes = _load_standard_fixtures()
    _install_standard_llm()

    set_sender(ADDR_ROOT)
    set_value(1000)
    contract = MandateTree()
    contract.initialize_tree(1000, 3600, SCOPE_ROOT, URL_ROOT, hashes["root"])
    set_value(0)

    # Mandate retry recovery: HTTP 503 on attempt 1 -> HTTP 200 on attempt 2 -> immutable on attempt 3
    contract.propose_mandate("root", "onco", ADDR_LEAD_ONCO, 500, SCOPE_ONCO, URL_ONCO, hashes["onco"])
    mock_web_responses[URL_ONCO] = MockWebResponse(status=503, body=b"Upstream timeout")
    assert contract.audit_mandate("onco") == "AUDIT_UNVERIFIABLE:onco:FETCH_OR_PARSE_FAILURE:ATTEMPT_1"
    assert json.loads(contract.get_mandate("onco"))["status"] == "PENDING_AUDIT"
    assert json.loads(contract.get_mandate("onco"))["attempts"] == 1
    _assert_conservation(contract)

    # Network recovers
    mock_web_responses[URL_ONCO] = MockWebResponse(status=200, body=_read_fixture("onco_charter.json"))
    assert contract.audit_mandate("onco") == "AUDIT_APPROVED:onco:SUBSUMED_AND_EXCLUSIVE"
    assert json.loads(contract.get_mandate("onco"))["attempts"] == 2
    with pytest.raises(UserError, match="MANDATE_ALREADY_CONCLUDED"):
        contract.audit_mandate("onco")

    # Conclusive REJECTED immutability
    contract.propose_mandate("root", "onco_dup", ADDR_ATTACKER, 50, SCOPE_ONCO_DUP, URL_ONCO_DUP, hashes["onco_dup"])
    assert contract.audit_mandate("onco_dup") == "AUDIT_REJECTED:onco_dup:SIBLING_OVERLAP"
    with pytest.raises(UserError, match="MANDATE_ALREADY_CONCLUDED"):
        contract.audit_mandate("onco_dup")

    # 5 consecutive UNVERIFIABLE attempts on audit_mandate -> 6th raises MAX_AUDIT_RETRIES_EXCEEDED
    url_flaky = f"{BASE_URL}/flaky_charter.json"
    mock_web_responses[url_flaky] = MockWebResponse(status=503, body=b"Down")
    contract.propose_mandate("root", "flaky", ADDR_LEAD_RADIO, 100, SCOPE_RADIO, url_flaky, "11" * 32)
    for i in range(1, MAX_AUDIT_ATTEMPTS + 1):
        assert contract.audit_mandate("flaky") == f"AUDIT_UNVERIFIABLE:flaky:FETCH_OR_PARSE_FAILURE:ATTEMPT_{i}"
        assert json.loads(contract.get_mandate("flaky"))["attempts"] == i
    with pytest.raises(UserError, match="MAX_AUDIT_RETRIES_EXCEEDED"):
        contract.audit_mandate("flaky")

    # Breach retry recovery: HTTP 503 on attempt 1 -> HTTP 200 COMPLIANT on attempt 2 -> immutable on attempt 3
    mock_web_responses[URL_BREACH_OK] = MockWebResponse(status=503, body=b"Temporary 503")
    assert contract.audit_breach("onco", URL_BREACH_OK, hashes["breach_ok"]) == "BREACH_UNVERIFIABLE:onco:FETCH_OR_PARSE_FAILURE:ATTEMPT_1"
    assert json.loads(contract.get_mandate("onco"))["status"] == "ACTIVE"

    mock_web_responses[URL_BREACH_OK] = MockWebResponse(status=200, body=_read_fixture("breach_compliant_audit.json"))
    assert contract.audit_breach("onco", URL_BREACH_OK, hashes["breach_ok"]) == "BREACH_COMPLIANT:onco:WITHIN_SCOPE"
    assert json.loads(contract.get_breach_audit("onco", hashes["breach_ok"]))["attempts"] == 2
    with pytest.raises(UserError, match="BREACH_ALREADY_EVALUATED"):
        contract.audit_breach("onco", URL_BREACH_OK, hashes["breach_ok"])

    # 5 consecutive UNVERIFIABLE attempts on audit_breach -> 6th raises MAX_BREACH_RETRIES_EXCEEDED
    url_b_fail = f"{BASE_URL}/flaky_breach.json"
    mock_web_responses[url_b_fail] = MockWebResponse(status=500, body=b"Err")
    b_hash = "22" * 32
    for i in range(1, MAX_AUDIT_ATTEMPTS + 1):
        assert contract.audit_breach("onco", url_b_fail, b_hash) == f"BREACH_UNVERIFIABLE:onco:FETCH_OR_PARSE_FAILURE:ATTEMPT_{i}"
    with pytest.raises(UserError, match="MAX_BREACH_RETRIES_EXCEEDED"):
        contract.audit_breach("onco", url_b_fail, b_hash)
    _assert_conservation(contract)


# =============================================================================
# 5. Reclaim Pending Mandate & Post-Deadline Expiry Sweep
# =============================================================================
def test_reclaim_pending_mandate_and_post_deadline_sweep():
    hashes = _load_standard_fixtures()
    _install_standard_llm()

    set_sender(ADDR_ROOT)
    set_time(1794900000)
    set_value(1000)
    contract = MandateTree()
    contract.initialize_tree(1000, 1000, SCOPE_ROOT, URL_ROOT, hashes["root"])
    set_value(0)

    # Proposal 1: outsider cannot reclaim prematurely; parent can reclaim anytime
    contract.propose_mandate("root", "p1", ADDR_LEAD_ONCO, 200, SCOPE_ONCO, URL_ONCO, hashes["onco"])
    set_sender(ADDR_ATTACKER)
    with pytest.raises(UserError, match="RECLAIM_NOT_AUTHORIZED"):
        contract.reclaim_pending_mandate("p1")

    set_sender(ADDR_ROOT)
    assert contract.reclaim_pending_mandate("p1") == "RECLAIMED:p1:AMOUNT_200"
    assert json.loads(contract.get_mandate("p1"))["status"] == "RECLAIMED"
    assert json.loads(contract.get_mandate("root"))["available_budget"] == 1000
    _assert_conservation(contract)

    # Proposal 2: permissionless reclaim after 5 failed attempts
    url_down = f"{BASE_URL}/down.json"
    mock_web_responses[url_down] = MockWebResponse(status=404, body=b"Not Found")
    contract.propose_mandate("root", "p2", ADDR_LEAD_RADIO, 150, SCOPE_RADIO, url_down, "33" * 32)
    for _ in range(MAX_AUDIT_ATTEMPTS):
        contract.audit_mandate("p2")

    set_sender(ADDR_ATTACKER)
    assert contract.reclaim_pending_mandate("p2") == "RECLAIMED:p2:AMOUNT_150"
    assert json.loads(contract.get_mandate("root"))["available_budget"] == 1000
    _assert_conservation(contract)

    # Proposal 3 (active) + Proposal 4 (pending) + post-deadline permissionless reclaim + sweep
    set_sender(ADDR_ROOT)
    contract.propose_mandate("root", "onco", ADDR_LEAD_ONCO, 400, SCOPE_ONCO, URL_ONCO, hashes["onco"])
    contract.audit_mandate("onco")
    contract.propose_mandate("root", "p4", ADDR_LEAD_RADIO, 100, SCOPE_RADIO, URL_RADIO, hashes["radio"])
    contract.propose_mandate("root", "p5", ADDR_SUB_PET, 50, SCOPE_RADIO, URL_RADIO, hashes["radio"])

    set_sender(ADDR_LEAD_ONCO)
    contract.execute_milestone("onco", 100, "Pre-deadline milestone")

    # Advance real block timestamp past deadline (1794900000 + 1000)
    set_time(1794901000)
    # Post-deadline permissionless reclaim of p4 succeeds
    set_sender(ADDR_ATTACKER)
    assert contract.reclaim_pending_mandate("p4") == "RECLAIMED:p4:AMOUNT_100"
    _assert_conservation(contract)

    # Post-deadline sweep_expired_tree collects all remaining ACTIVE + PENDING_AUDIT (900) for root_principal
    assert contract.sweep_expired_tree() == "TREE_SWEPT:AMOUNT_900"
    assert json.loads(contract.get_mandate("root"))["status"] == "EXPIRED"
    assert json.loads(contract.get_mandate("onco"))["status"] == "EXPIRED"
    assert json.loads(contract.get_mandate("p5"))["status"] == "EXPIRED"
    _assert_conservation(contract)

    # Double sweep blocked
    with pytest.raises(UserError, match="TREE_ALREADY_SWEPT"):
        contract.sweep_expired_tree()

    # Root withdraws 900 swept + LeadOnco withdraws 100 spent -> 0 stranded wei
    set_sender(ADDR_ROOT)
    assert contract.withdraw_payout() == 900
    set_sender(ADDR_LEAD_ONCO)
    assert contract.withdraw_payout() == 100

    acct = _assert_conservation(contract)
    assert acct["total_active_available"] == 0
    assert acct["total_pending_reserved"] == 0
    assert acct["total_pending_payouts"] == 0
    assert acct["total_withdrawn"] == 1000
    assert len(emitted_transfers) == 2


# =============================================================================
# 6. Anti-TOCTOU Live Sibling Overlap Guard
# =============================================================================
def test_anti_toctou_live_sibling_overlap():
    hashes = _load_standard_fixtures()
    _install_standard_llm()

    set_sender(ADDR_ROOT)
    set_value(1000)
    contract = MandateTree()
    contract.initialize_tree(1000, 3600, SCOPE_ROOT, URL_ROOT, hashes["root"])
    set_value(0)

    # Propose TWO overlapping PENDING_AUDIT siblings back-to-back before either is audited
    contract.propose_mandate("root", "onco_a", ADDR_LEAD_ONCO, 300, SCOPE_ONCO, URL_ONCO, hashes["onco"])
    contract.propose_mandate("root", "onco_b", ADDR_ATTACKER, 300, SCOPE_ONCO_DUP, URL_ONCO_DUP, hashes["onco_dup"])
    assert json.loads(contract.get_mandate("onco_b"))["proposed_sibling_scopes"] == []

    # First audit activates onco_a (zero active siblings at audit time)
    assert contract.audit_mandate("onco_a") == "AUDIT_APPROVED:onco_a:SUBSUMED_AND_EXCLUSIVE"
    # Second audit snapshots LIVE active siblings (sees onco_a) -> rejects onco_b!
    assert contract.audit_mandate("onco_b") == "AUDIT_REJECTED:onco_b:SIBLING_OVERLAP"
    assert json.loads(contract.get_mandate("root"))["available_budget"] == 700
    _assert_conservation(contract)


# =============================================================================
# 7. Payable, Input, Fail-Closed Evidence & Tree Depth/Size/Milestone Bounds
# =============================================================================
def test_payable_input_fail_closed_evidence_and_bounds():
    hashes = _load_standard_fixtures()

    # Reusable URL allowlist tests
    assert is_valid_evidence_url(f"https://raw.githubusercontent.com/AnyOrg/Any-Repo/{COMMIT_SHA}/dir/file.json") is True
    assert is_valid_evidence_url(f"https://raw.githubusercontent.com/Kanezar3/MandateTree/main/evidence/root.json") is False
    assert is_valid_evidence_url(f"https://raw.githubusercontent.com/Kanezar3/MandateTree/{COMMIT_SHA.upper()}/a.json") is False
    assert is_valid_evidence_url(f"https://raw.githubusercontent.com/Kanezar3/MandateTree/{COMMIT_SHA}/a/../b.json") is False
    assert is_valid_evidence_url(f"https://raw.githubusercontent.com/Kanezar3/MandateTree/{COMMIT_SHA}/a.json?x=1") is False
    assert is_valid_evidence_url(f"https://raw.githubusercontent.com/Kanezar3/MandateTree/{COMMIT_SHA}/a.json#frag") is False
    assert is_valid_evidence_url(f"https://raw.githubusercontent.com/Kanezar3/MandateTree/{COMMIT_SHA}//a.json") is False
    assert is_valid_evidence_url(f"https://raw.githubusercontent.com/Kanezar3/MandateTree/{COMMIT_SHA}/a.json/") is False
    assert is_valid_mandate_id("root") is False
    assert is_valid_mandate_id("a") is False
    assert is_valid_mandate_id("BadUpper") is False
    assert is_valid_mandate_id("valid_id-01") is True
    assert is_valid_address(ZERO_ADDRESS) is False
    assert is_valid_sha256_hex("z" * 64) is False

    set_sender(ADDR_ROOT)
    contract = MandateTree()

    # Payable value mismatch & invalid init inputs
    set_value(500)
    with pytest.raises(UserError, match="BUDGET_VALUE_MISMATCH"):
        contract.initialize_tree(1000, 3600, SCOPE_ROOT, URL_ROOT, hashes["root"])
    set_value(0)
    with pytest.raises(UserError, match="INVALID_BUDGET"):
        contract.initialize_tree(0, 3600, SCOPE_ROOT, URL_ROOT, hashes["root"])
    with pytest.raises(UserError, match="INVALID_BUDGET"):
        contract.initialize_tree(True, 3600, SCOPE_ROOT, URL_ROOT, hashes["root"])
    set_value(1000)
    with pytest.raises(UserError, match="INVALID_DURATION"):
        contract.initialize_tree(1000, 10, SCOPE_ROOT, URL_ROOT, hashes["root"])
    set_time(None)
    with pytest.raises(UserError, match="NO_BLOCK_TIME"):
        contract.initialize_tree(1000, 3600, SCOPE_ROOT, URL_ROOT, hashes["root"])
    set_time(1794900000)
    contract.initialize_tree(1000, 3600, SCOPE_ROOT, URL_ROOT, hashes["root"])
    with pytest.raises(UserError, match="TREE_ALREADY_INITIALIZED"):
        contract.initialize_tree(1000, 3600, SCOPE_ROOT, URL_ROOT, hashes["root"])
    set_value(0)

    # Cannot revoke root & no pending payout
    with pytest.raises(UserError, match="CANNOT_REVOKE_ROOT"):
        contract.audit_breach("root", URL_BREACH_BAD, hashes["breach_bad"])
    with pytest.raises(UserError, match="NO_PENDING_PAYOUT"):
        contract.withdraw_payout()

    # Fail-closed evidence checks: empty body, oversized > 2500 B, invalid UTF-8, SHA-256 mismatch, hallucinated LLM
    bad_cases = [
        ("ev_empty", MockWebResponse(status=200, body=b""), "FETCH_OR_PARSE_FAILURE"),
        ("ev_big", MockWebResponse(status=200, body=b"x" * (MAX_EVIDENCE_BYTES + 1)), "FETCH_OR_PARSE_FAILURE"),
        ("ev_utf8", MockWebResponse(status=200, body=b"\xff\xfe\xfd"), "FETCH_OR_PARSE_FAILURE"),
        ("ev_hash", MockWebResponse(status=200, body=b'{"ok":true}'), "HASH_MISMATCH"),
    ]
    for mid, resp, expected_reason in bad_cases:
        u = f"{BASE_URL}/{mid}.json"
        mock_web_responses[u] = resp
        contract.propose_mandate("root", mid, ADDR_LEAD_ONCO, 10, SCOPE_ONCO, u, "aa" * 32)
        assert contract.audit_mandate(mid) == f"AUDIT_UNVERIFIABLE:{mid}:{expected_reason}:ATTEMPT_1"
        contract.reclaim_pending_mandate(mid)

    # Hallucinated LLM enum fails closed to UNVERIFIABLE
    mock_llm_responses.clear()
    mock_llm_responses.append(lambda _: {"subsumed_by_parent": "maybe", "verdict": "INVENTED", "reason": "BOGUS"})
    contract.propose_mandate("root", "ev_halluc", ADDR_LEAD_ONCO, 10, SCOPE_ONCO, URL_ONCO, hashes["onco"])
    assert contract.audit_mandate("ev_halluc") == "AUDIT_UNVERIFIABLE:ev_halluc:FETCH_OR_PARSE_FAILURE:ATTEMPT_1"
    contract.reclaim_pending_mandate("ev_halluc")
    _assert_conservation(contract)

    # Deep 4-level chain (depth 0 -> 1 -> 2 -> 3 -> 4) and MAX_DEPTH_EXCEEDED on depth 5
    mock_llm_responses.clear()
    mock_llm_responses.append(lambda _: {
        "subsumed_by_parent": True,
        "exclusive_from_siblings": True,
        "verdict": "APPROVED",
        "reason": "SUBSUMED_AND_EXCLUSIVE",
    })
    chain = [
        ("root", "d1", ADDR_ROOT, ADDR_LEAD_ONCO, 400),
        ("d1", "d2", ADDR_LEAD_ONCO, ADDR_SUB_PET, 300),
        ("d2", "d3", ADDR_SUB_PET, ADDR_SUB_DEEP3, 200),
        ("d3", "d4", ADDR_SUB_DEEP3, ADDR_SUB_DEEP4, 100),
    ]
    for parent_id, child_id, delegator, delegatee, bud in chain:
        set_sender(delegator)
        contract.propose_mandate(parent_id, child_id, delegatee, bud, f"Scope {child_id}", URL_ONCO, hashes["onco"])
        assert contract.audit_mandate(child_id) == f"AUDIT_APPROVED:{child_id}:SUBSUMED_AND_EXCLUSIVE"
    assert json.loads(contract.get_mandate("d4"))["depth"] == MAX_DEPTH

    # Depth 5 blocked
    set_sender(ADDR_SUB_DEEP4)
    with pytest.raises(UserError, match="MAX_DEPTH_EXCEEDED"):
        contract.propose_mandate("d4", "d5", ADDR_ATTACKER, 50, "Too deep", URL_ONCO, hashes["onco"])
    _assert_conservation(contract)


def test_max_children_max_mandates_and_max_milestones_bounds():
    hashes = _load_standard_fixtures()
    mock_llm_responses.clear()
    mock_llm_responses.append(lambda _: {
        "subsumed_by_parent": True,
        "exclusive_from_siblings": True,
        "verdict": "APPROVED",
        "reason": "SUBSUMED_AND_EXCLUSIVE",
    })

    set_sender(ADDR_ROOT)
    set_value(10000)
    contract = MandateTree()
    contract.initialize_tree(10000, 3600, SCOPE_ROOT, URL_ROOT, hashes["root"])
    set_value(0)

    # Create MAX_CHILDREN_PER_NODE (16) children under root -> 17th blocked
    for i in range(MAX_CHILDREN_PER_NODE):
        mid = f"c1_{i:02d}"
        contract.propose_mandate("root", mid, ADDR_LEAD_ONCO, 500, f"Child {i}", URL_ONCO, hashes["onco"])
        contract.audit_mandate(mid)
    with pytest.raises(UserError, match="MAX_CHILDREN_EXCEEDED"):
        contract.propose_mandate("root", "c1_overflow", ADDR_LEAD_ONCO, 10, "Overflow", URL_ONCO, hashes["onco"])

    # Fill up to MAX_TOTAL_MANDATES (64) across children -> 65th blocked
    set_sender(ADDR_LEAD_ONCO)
    created = 1 + MAX_CHILDREN_PER_NODE  # root + 16 children = 17
    parent_idx = 0
    child_idx = 0
    while created < MAX_TOTAL_MANDATES:
        pid = f"c1_{parent_idx:02d}"
        mid = f"g_{parent_idx:02d}_{child_idx:02d}"
        contract.propose_mandate(pid, mid, ADDR_SUB_PET, 10, f"Grandchild {mid}", URL_ONCO, hashes["onco"])
        created += 1
        child_idx += 1
        if child_idx >= MAX_CHILDREN_PER_NODE:
            parent_idx += 1
            child_idx = 0

    with pytest.raises(UserError, match="MAX_MANDATES_EXCEEDED"):
        contract.propose_mandate("c1_05", "over_64", ADDR_SUB_PET, 10, "Over 64", URL_ONCO, hashes["onco"])

    # Hit MAX_MILESTONES (128) -> 129th blocked
    set_sender(ADDR_ROOT)
    for i in range(MAX_MILESTONES):
        contract.execute_milestone("root", 1, f"Milestone {i}")
    with pytest.raises(UserError, match="MAX_MILESTONES_EXCEEDED"):
        contract.execute_milestone("root", 1, "Milestone overflow")
    _assert_conservation(contract)
