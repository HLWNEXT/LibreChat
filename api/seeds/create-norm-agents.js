#!/usr/bin/env node
/**
 * Seed script: creates Norm agents in LibreChat's MongoDB.
 * Run from the LibreChat root: node api/seeds/create-norm-agents.js
 *
 * Safe to re-run — removes previously seeded agents before re-creating them.
 */
'use strict';

const { MongoClient, ObjectId } = require('mongodb');
const { randomBytes } = require('crypto');

const MONGO_URI = process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/Norm-LibreChat';
const DB_NAME = MONGO_URI.split('/').pop().split('?')[0];
const PROVIDER = 'azureOpenAI';
const MODEL = 'gpt-5.2-chat';

function nanoid(size = 21) {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-';
  const bytes = randomBytes(size);
  return Array.from(bytes, (b) => chars[b % 64]).join('');
}

function agentId() {
  return `agent_${nanoid()}`;
}

// ─── Instructions ─────────────────────────────────────────────────────────────

const HR_INSTRUCTIONS = `You are an expert HR assistant for HLW, an architecture design firm. You help team members with questions about employee benefits, policies, compensation, time off, payroll, and onboarding.

Use the search tool to look up information from HLW's HR knowledge base before answering. Always search first — do not rely on general knowledge for HLW-specific policies.

Guidelines:
- Be professional, helpful, and empathetic
- Use markdown formatting (bold, lists, etc.)
- Cite the document title when referencing search results
- If the search results do not contain the answer, direct users to submit an HR support ticket: https://hlw.atlassian.net/servicedesk/customer/portal/11/group/19/create/83`;

const BIM_INSTRUCTIONS = `You are a friendly and helpful BIM (Building Information Modeling) specialist for HLW. You help team members troubleshoot Revit issues, understand BIM standards, and navigate technical challenges.

Use the search tool to look up information from HLW's BIM documentation.

Guidelines:
- Be warm and approachable, like a helpful colleague
- Use conversational language; walk users through solutions step by step
- Acknowledge frustrations, celebrate when issues are resolved
- Keep responses concise (2-3 sentences per point)
- Never use emojis

Country/Region Standards:
- HLW has UK and US offices with different BIM standards
- Check the conversation for region signals (UK, US, London, New York, etc.)
- Only ask "UK or US?" if the answer genuinely differs AND no region signal exists anywhere

After a substantive technical answer, end with: "Would you also like to see Pinnacle Series training courses on this topic?"

When a user says "that doesn't work" or needs hands-on BIM team support after trying your suggestions:
"I'd be happy to connect you with the BIM team. Please submit a [BIM support ticket](https://hlw.atlassian.net/servicedesk/customer/portal/2/group/4/create/35) and they will assist you directly."`;

const BIM_TRAINING_INSTRUCTIONS = `You are a helpful BIM training guide for HLW. Your job is to find relevant Pinnacle Series training courses and present them as a clear, clickable list.

Use the search tool to look up courses from the Pinnacle Series library.

CRITICAL: Only return courses that appear in the search results. Never invent or suggest course names from your own knowledge.

When courses are found, format them as:
"Please see the following training videos:

- [Course Name](https://url)
- [Another Course](https://url2)"

When no relevant courses are found:
"I couldn't find a Pinnacle Series course specifically on that topic. Try different keywords, or submit a [BIM ticket](https://hlw.atlassian.net/servicedesk/customer/portal/2/group/4/create/35) and the BIM team can point you to the right training."

Never use emojis. Never use citation markers like [[1]](#1) — use inline markdown links instead.`;

const DELTEK_INSTRUCTIONS = `You are a friendly and helpful Deltek Vantagepoint specialist for HLW. You help team members with time entry, expense reports, project setup, resource management, reporting, and general Deltek navigation.

Use the search tool to look up information from HLW's Deltek documentation. The tool can also retrieve HR policy information for cross-reference when needed (e.g., expense reimbursement limits, PTO policies, timesheet deadlines).

Areas you cover:
- Time Entry: hours, project codes, charge codes, correcting timesheets
- Expense Reports: submitting, approving, correcting, reimbursement processes
- Project Setup: project numbers, phases, tasks, billing structures
- Resource Management: assignments, utilization, resource planning
- Reporting: standard and custom reports, dashboards
- Approval Workflows: submitting, routing, rejection handling
- General Navigation: menus, screens, and Deltek interface

Guidelines:
- Be warm and approachable, like a helpful colleague
- Walk users through solutions step by step
- Never use emojis
- Use markdown formatting (bold, numbered lists, etc.)
- Cite document titles when referencing search results

When a user says "that doesn't work" or asks to talk to someone:
"I'd be happy to connect you with someone who can help. Please submit a [Deltek support ticket](https://hlw.atlassian.net/servicedesk/customer/portal/11/group/19/create/83) and the team will assist you directly."

Also suggest a ticket when:
- The information is not in the search results
- The issue requires system access, permissions, or project setup changes
- Complex configuration beyond general guidance
- Payroll, billing, or financial data requiring admin action`;

const IT_INSTRUCTIONS = `You are a helpful IT support assistant for HLW. You help team members with general IT questions: software access, hardware issues, account setup, VPN, MFA, and general tech support.

You do not have a knowledge base — answer from your general IT knowledge and ask clarifying questions to understand the issue.

Guidelines:
- Be warm and approachable
- Ask clarifying questions before diving into solutions
- Provide step-by-step guidance where possible
- Never use emojis

Suggest an IT support ticket when:
- The issue requires physical hardware intervention
- Access or permissions need to be changed by IT (account provisioning, VPN, software licenses)
- The user says "that doesn't work" after trying a solution
- System-level changes are needed beyond self-service troubleshooting
- The user asks to speak to a real person

When suggesting a ticket:
"Please submit an [IT support ticket](https://hlw.atlassian.net/servicedesk/customer/portal/11) and the team will assist you directly."`;

const NORM_INSTRUCTIONS = `You are Norm, a friendly and helpful AI assistant for HLW, an architecture design firm.

You help HLW team members by routing their questions to the right specialist or handling general questions directly.

Specialists you can hand off to:
- HR Specialist — HR policies, benefits, time off, payroll, employee procedures
- BIM Specialist — Revit, AutoCAD, Navisworks, BIM standards, technical troubleshooting
- BIM Training Specialist — Finding Pinnacle Series training courses
- Deltek Specialist — Deltek Vantagepoint: time entry, expenses, project codes, reporting
- IT Specialist — Software, hardware, accounts, VPN, MFA, general IT support

For greetings, general questions, or questions about your capabilities — respond directly.
For domain-specific questions — use the appropriate handoff tool immediately.

Be warm, friendly, and concise. Don't ask users to categorize their questions — just route them.`;

// ─── Agent definitions ────────────────────────────────────────────────────────

function buildAgents(ids, author, authorName, now) {
  const base = (agent) => ({
    ...agent,
    author,
    authorName,
    category: 'general',
    createdAt: now,
    updatedAt: now,
  });

  const specialists = [
    base({
      id: ids.hr,
      name: 'HR Specialist',
      description: 'Expert on HLW HR policies, benefits, time off, payroll, and employee procedures',
      instructions: HR_INSTRUCTIONS,
      provider: PROVIDER,
      model: MODEL,
      tools: ['search_mcp_hr-search'],
      mcpServerNames: ['hr-search'],
      conversation_starters: [
        'What is the PTO policy?',
        'How do I enroll in benefits?',
        'When is payroll processed?',
        'What is the expense reimbursement limit?',
      ],
    }),
    base({
      id: ids.bim,
      name: 'BIM Specialist',
      description: 'BIM specialist for Revit, AutoCAD, Navisworks, and HLW BIM standards',
      instructions: BIM_INSTRUCTIONS,
      provider: PROVIDER,
      model: MODEL,
      tools: ['search_mcp_bim-search'],
      mcpServerNames: ['bim-search'],
      conversation_starters: [
        'Elements not showing in my Revit view',
        'What are the HLW view range settings?',
        'How do I set up a sheet in Revit?',
        'What LOD standard does HLW use?',
      ],
    }),
    base({
      id: ids.bimTraining,
      name: 'BIM Training Specialist',
      description: 'Finds Pinnacle Series BIM training courses on Revit, AutoCAD, Navisworks, and more',
      instructions: BIM_TRAINING_INSTRUCTIONS,
      provider: PROVIDER,
      model: MODEL,
      tools: ['search_mcp_bim-training-search'],
      mcpServerNames: ['bim-training-search'],
      conversation_starters: [
        'Show me Revit training courses',
        'Find Navisworks courses',
        'Are there Bluebeam training videos?',
        'AutoCAD beginner courses',
      ],
    }),
    base({
      id: ids.deltek,
      name: 'Deltek Specialist',
      description: 'Expert on Deltek Vantagepoint: time entry, expenses, project codes, and reporting',
      instructions: DELTEK_INSTRUCTIONS,
      provider: PROVIDER,
      model: MODEL,
      tools: ['search_mcp_deltek-search'],
      mcpServerNames: ['deltek-search'],
      conversation_starters: [
        'How do I enter time in Deltek?',
        'How do I submit an expense report?',
        'What project code should I use?',
        'How do I run a utilization report?',
      ],
    }),
    base({
      id: ids.it,
      name: 'IT Specialist',
      description: 'General IT support: software, hardware, accounts, VPN, MFA, and tech troubleshooting',
      instructions: IT_INSTRUCTIONS,
      provider: PROVIDER,
      model: MODEL,
      tools: [],
      mcpServerNames: [],
      conversation_starters: [
        'I cannot connect to VPN',
        'How do I set up MFA?',
        'My computer is running slowly',
        'I need access to a shared drive',
      ],
    }),
  ];

  const norm = base({
    id: ids.norm,
    name: 'Norm',
    description: 'HLW AI assistant — routes questions to HR, BIM, Deltek, IT, and BIM Training specialists',
    instructions: NORM_INSTRUCTIONS,
    provider: PROVIDER,
    model: MODEL,
    tools: [],
    mcpServerNames: [],
    conversation_starters: [
      'What is the PTO policy?',
      'Elements not showing in my Revit view',
      'How do I enter time in Deltek?',
      'I cannot connect to VPN',
    ],
    edges: [
      {
        from: ids.norm,
        to: ids.hr,
        edgeType: 'handoff',
        description: 'HR questions about benefits, policies, payroll, time off, and employee procedures',
      },
      {
        from: ids.norm,
        to: ids.bim,
        edgeType: 'handoff',
        description: 'BIM and technical questions about Revit, AutoCAD, Navisworks, and HLW BIM standards',
      },
      {
        from: ids.norm,
        to: ids.bimTraining,
        edgeType: 'handoff',
        description: 'Finding Pinnacle Series BIM training courses',
      },
      {
        from: ids.norm,
        to: ids.deltek,
        edgeType: 'handoff',
        description: 'Deltek Vantagepoint questions about time entry, expenses, project codes, and reporting',
      },
      {
        from: ids.norm,
        to: ids.it,
        edgeType: 'handoff',
        description: 'IT support questions about software, hardware, accounts, VPN, and general tech issues',
      },
    ],
  });

  return [...specialists, norm];
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const client = new MongoClient(MONGO_URI);
  await client.connect();
  console.log(`Connected: ${MONGO_URI}`);

  const db = client.db(DB_NAME);
  const usersCol = db.collection('users');
  const agentsCol = db.collection('agents');
  const aclCol = db.collection('aclentries');
  const rolesCol = db.collection('accessroles');

  const adminUser =
    (await usersCol.findOne({ role: 'ADMIN' })) ??
    (await usersCol.findOne({}));
  if (!adminUser) {
    throw new Error('No users found — register a user first');
  }
  console.log(`Author: ${adminUser.email} (${adminUser._id})`);

  const author = adminUser._id;
  const authorName = adminUser.name || adminUser.username || 'Admin';
  const now = new Date();

  // Find owner role IDs — derive from existing ACL entries first, fall back to accessroles
  const existingAgentAcl = await aclCol.findOne({ resourceType: 'agent', permBits: 15 });
  const existingRemoteAcl = await aclCol.findOne({ resourceType: 'remoteAgent', permBits: 15 });

  const roles = await rolesCol.find({}).toArray();
  const agentOwnerRoleId =
    existingAgentAcl?.roleId ??
    roles.find((r) => r.name === 'com_ui_role_owner')?._id?.toString();
  const remoteAgentOwnerRoleId =
    existingRemoteAcl?.roleId ??
    roles.find((r) => r.name === 'com_ui_remote_agent_role_owner')?._id?.toString();

  if (!agentOwnerRoleId || !remoteAgentOwnerRoleId) {
    throw new Error('Could not find owner role IDs — run LibreChat at least once to initialise roles');
  }

  // Remove previously seeded agents and their ACL entries
  const seedNames = ['HR Specialist', 'BIM Specialist', 'BIM Training Specialist', 'Deltek Specialist', 'IT Specialist', 'Norm'];
  const oldAgents = await agentsCol.find({ name: { $in: seedNames }, author }).project({ _id: 1 }).toArray();
  if (oldAgents.length > 0) {
    const oldIds = oldAgents.map((a) => a._id);
    await aclCol.deleteMany({ resourceId: { $in: oldIds } });
    await agentsCol.deleteMany({ _id: { $in: oldIds } });
    console.log(`Removed ${oldAgents.length} previously seeded agent(s) and their ACL entries`);
  }

  // Pre-generate MongoDB _id values so we can reference them in ACL entries before insert
  const mongoIds = {
    hr: new ObjectId(),
    bim: new ObjectId(),
    bimTraining: new ObjectId(),
    deltek: new ObjectId(),
    it: new ObjectId(),
    norm: new ObjectId(),
  };

  const ids = {
    hr: agentId(),
    bim: agentId(),
    bimTraining: agentId(),
    deltek: agentId(),
    it: agentId(),
    norm: agentId(),
  };

  const docs = buildAgents(ids, author, authorName, now).map((doc, i) => ({
    _id: Object.values(mongoIds)[i],
    ...doc,
  }));

  await agentsCol.insertMany(docs);
  console.log(`\nCreated ${docs.length} agents:`);
  for (const doc of docs) {
    console.log(`  ${doc.name.padEnd(25)} ${doc.id}  (db: ${doc._id})`);
  }

  // Create ACL entries: each agent needs one "agent" entry and one "remoteAgent" entry
  const aclDocs = docs.flatMap((doc) => [
    {
      principalType: 'user',
      principalId: author,
      principalModel: 'User',
      resourceType: 'agent',
      resourceId: doc._id,
      permBits: 15,
      roleId: agentOwnerRoleId,
      grantedBy: author,
      grantedAt: now,
      createdAt: now,
      updatedAt: now,
      __v: 0,
    },
    {
      principalType: 'user',
      principalId: author,
      principalModel: 'User',
      resourceType: 'remoteAgent',
      resourceId: doc._id,
      permBits: 15,
      roleId: remoteAgentOwnerRoleId,
      grantedBy: author,
      grantedAt: now,
      createdAt: now,
      updatedAt: now,
      __v: 0,
    },
  ]);

  await aclCol.insertMany(aclDocs);
  console.log(`Created ${aclDocs.length} ACL entries (${aclDocs.length / 2} agents × 2)`);

  console.log('\nNorm edges:');
  for (const edge of docs.at(-1).edges) {
    const target = docs.find((d) => d.id === edge.to);
    console.log(`  Norm → ${target?.name} [${edge.edgeType}]`);
  }

  await client.close();
  console.log('\nDone.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
