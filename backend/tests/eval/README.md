# Eval stubs

Golden Vietnamese grounding cases and adversarial prompt fixtures for AI evaluation.

Run the eval harness:

```powershell
pnpm test:eval
```

Or from the repository root with the AI project directory selected:

```powershell
uv run --directory backend/apps/ai python ../../tests/eval/run_stub.py
```

The runner verifies:

- at least 10 adversarial markdown cases under `backend/tests/eval/adversarial`
- at least 5 golden grounded VI cases under `backend/tests/eval/golden`
- mocked orchestrator expectations for each golden case
