# Norm on LibreChat — Team Test Guide

This guide is for the team smoke-testing the Norm chatbot running on LibreChat.
Norm works the same way as in Teams — you ask a question, Norm routes it to the right specialist and searches our knowledge bases — but now through a web UI instead of Microsoft Teams.

---

## Access

Open your browser and go to: **`[LIBRECHAT_URL]`**

Sign in with your Microsoft account (same SSO as usual).

---

## How to start a conversation with Norm

1. Click **New Chat** (top left)
2. In the model/agent selector at the top of the chat input, select **Norm**
3. Type your question and press Enter

You do not need to tell Norm which domain your question belongs to — it figures that out and hands off to the right specialist automatically.

---

## Test scenarios

Please try each scenario below, note what response you get, and flag anything that looks wrong or missing.

### HR questions
> Tests the HR knowledge base (policies, benefits, payroll)

- "How many days of PTO do I get per year?"
- "What is the process for requesting parental leave?"
- "How do I set up direct deposit?"

**Expected:** Norm should hand off to the HR specialist, search our HR documents, and return an answer with citations.

---

### Deltek Vantagepoint questions
> Tests the Deltek knowledge base (time entry, expenses, project codes)

- "How do I submit my timesheet in Deltek?"
- "Where do I enter project expenses?"
- "How do I find the right project code for a task?"

**Expected:** Norm should hand off to the Deltek specialist and return step-by-step guidance from Deltek documentation.

---

### BIM questions
> Tests the BIM knowledge base (Revit, AutoCAD, Navisworks, BIM standards)

- "How do I link a Revit model into Navisworks?"
- "What are HLW's standards for Revit file naming?"
- "How do I set up a sheet in Revit?"

**Expected:** Norm should hand off to the BIM specialist and return answers from BIM documentation.

---

### BIM Training questions
> Tests the Pinnacle Series training catalog

- "Are there any Revit training courses available?"
- "What Bluebeam courses do we have?"
- "Is there a course on Navisworks clash detection?"

**Expected:** Norm should hand off to the BIM Training specialist and return relevant courses from the Pinnacle Series catalog.

---

### Cross-domain questions
> Tests that Norm can pull from two knowledge bases when a question spans HR and Deltek

- "What is the reimbursement limit for expenses I submit in Deltek?"
- "How do I enter PTO in Deltek?"

**Expected:** Norm should return an answer that combines HR policy (the limit or PTO rules) with Deltek instructions (how to enter it in the system).

---

### General tasks
> Tests that Norm handles non-search tasks directly without routing to a specialist

- Paste a paragraph of text and ask: "Can you summarize this?"
- Paste a paragraph with typos and ask: "Can you fix the grammar?"
- "What day is Thanksgiving this year?"

**Expected:** Norm should answer directly without searching any knowledge base.

---

## What to look for

| What | Good sign | Flag if |
|---|---|---|
| **Response time** | Answer appears within ~15–30 seconds | Takes more than 60 seconds or times out |
| **Citations** | Source documents are listed below the answer | Answer is given but no sources are shown |
| **Routing** | Norm picks the right specialist | Norm gives a generic "I don't know" or wrong domain answer |
| **Cross-domain** | Answer covers both HR policy and Deltek steps | Only one side is covered |
| **General tasks** | Direct answer, no search | Response says "searching..." but returns nothing |

---

## How to report issues

Please note:
1. The exact question you typed
2. What you expected
3. What actually happened (screenshot is helpful)

Share in the `#norm-librechat-testing` channel or reply to the test thread.

---

## Known limitations (not bugs)

- Norm does not have memory across separate conversations — start a new chat each time
- Norm does not handle file uploads in this initial version
- IT-related questions (Jira tickets, IT support) are not yet connected in the web UI
