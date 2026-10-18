---
name: phishguard-cloud-escalate
description: >-
  Runbook for managing, testing, and debugging the FastAPI cloud escalation gateway,
  domain reputation caching, and multimodal Teacher model evaluations in PhishGuard.
---

# PhishGuard Cloud Escalation Gateway Runbook

This skill guides the agent through operating and verifying the cloud escalation tier.

---

## 1. Operating the Escalation Gateway

The gateway listens for client escalations at `POST /v1/escalate`.

### Starting the Server
```powershell
.\.venv\Scripts\uvicorn phishguard_backend.main:app --host 0.0.0.0 --port 8000 --reload
```
Swagger UI: `http://localhost:8000/docs`

---

## 2. Testing Escalation Logic

Execute an escalation verification query:

```powershell
.\.venv\Scripts\python.exe -m pytest apps/backend/tests/test_escalate_api.py -v
```

### Key Scenarios
1. **Benign Reputation Fast-Path:**
   - Domains like `google.com` or `microsoft.com` bypass heavy neural evaluation and return immediate `ALLOW` verdicts.
2. **Suspicious Behavioral Escalation:**
   - Payloads with credential inputs inside cross-origin iframes or impersonating brand names produce `BLOCK` verdicts with detailed explanation reasons.
3. **Authentication Verification:**
   - In production mode, requests lacking valid Bearer tokens are rejected with 401 / 403.
