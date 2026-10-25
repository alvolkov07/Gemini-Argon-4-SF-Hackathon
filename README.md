# Gemini 4 Argon: AI PCB Inspector & Design Rule Checker

An a PCB design verification estimator agent powered by  **Gemini 4 Argon** (`gemini-4-argon`) via the **Interactions API**. 

The agent analyzes PCB layout diagrams, schematics, and Gerber preview images to detect potential electrical, manufacturing, and signal integrity flaws, classifying them by severity and recommending actionable remediation.

The data was tested and evaluated from an existing dataset of zoomed-in snapshots of PCB sections: https://github.com/tangsanli5201/DeepPCB/tree/master/PCBData. 

---

## Features

- **Gemini 4 Argon Reasoning (`thinking_level="high"`):** Harnesses deep multi-step reasoning to evaluate high-speed traces, loop inductances, acid traps, and thermal dissipation paths.
- **Structured Flaw Classification:** Categorizes defects into DRC violations, Signal Integrity (SI), Power Integrity (PI), Thermal Management, and DFM/Assembly yield risks.
- **Automated Synthetic Demo Generator:** Generates a synthetic test PCB with intentional flaws (e.g., acute angle acid traps, misplaced decoupling capacitors, solder bridge clearances) to test without external data.
- **Formatted Reports:** Generates Markdown and machine-readable JSON reports with an overall design health score.

---

## Quickstart

### 1. Installation
Clone the repository and install the dependencies:
```bash
python3 -m pip install -r requirements.txt
```

### 2. Configure API Key
Create a `.env` file in the project root:
```bash
cp .env.example .env
```
Execute in the terminal: 
```bash
export GEMINI_API_KEY="YourGeminiKey"
export GEMINI_MODEL_ID="gemini-4-argon"
python3 app.py
```





