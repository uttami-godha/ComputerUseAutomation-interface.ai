// HTML pages for the zero-dependency mock servicing console.
// Intentionally old-school markup in a few places so discovery/replay has to
// deal with the kinds of structures found in legacy back-office applications.

export const TENANTS = {
  "cu-a": {
    memberLabel: "Member ID",
    searchLabel: "Search",
    savingsLabel: "Savings Balance",
  },
  "cu-b": {
    memberLabel: "Member Number",
    searchLabel: "Find Member",
    savingsLabel: "Savings Bal.",
  },
} as const;

export type TenantId = keyof typeof TENANTS;

export function escapeHtml(value: unknown): string {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function layout(title: string, body: string): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(title)} - MemberServicing</title>
  <style>
    body {
      font-family: Arial, Helvetica, sans-serif;
      margin: 0;
      background: #f3f3f3;
      color: #222;
    }
    header {
      background: #17365d;
      color: white;
      padding: 14px 22px;
    }
    header h1 {
      margin: 0;
      font-size: 20px;
    }
    nav {
      margin-top: 8px;
      font-size: 14px;
    }
    nav a {
      color: white;
      margin-right: 16px;
    }
    main {
      width: 760px;
      margin: 28px auto;
      background: white;
      border: 1px solid #bbb;
      padding: 24px;
    }
    table {
      border-collapse: collapse;
      width: 100%;
    }
    th, td {
      border: 1px solid #bbb;
      padding: 8px 10px;
      text-align: left;
    }
    label {
      display: inline-block;
      min-width: 150px;
      margin-bottom: 12px;
    }
    input, select {
      padding: 6px;
      min-width: 220px;
    }
    button, .button {
      padding: 7px 14px;
      margin-top: 10px;
    }
    .error {
      border: 1px solid #b00;
      background: #fee;
      color: #900;
      padding: 10px;
      margin-bottom: 16px;
    }
    .notice {
      border: 1px solid #b89b32;
      background: #fff7d6;
      padding: 10px;
      margin-bottom: 16px;
    }
    .muted {
      color: #666;
      font-size: 13px;
    }
  </style>
</head>
<body>
  <header>
    <h1>MemberServicing</h1>
    <nav>
      <a href="./">Home</a>
      <a href="./logout">Sign Out</a>
    </nav>
  </header>
  <main>
    ${body}
  </main>
</body>
</html>`;
}

export function loginPage(
  tenantId: TenantId,
  error?: string,
): string {
  return layout(
    "Sign In",
    `
<h2>Operator Sign In</h2>
${error ? `<div class="error">${escapeHtml(error)}</div>` : ""}
<form method="post" action="/t/${tenantId}/login">
  <div>
    <span>Operator ID</span>
    <input name="op" autocomplete="username">
  </div>
  <div>
    <span>Password</span>
    <input name="pw" type="password" autocomplete="current-password">
  </div>
  <button type="submit">Sign In</button>
</form>
`,
  );
}

export function dashboardPage(
  tenantId: TenantId,
  message?: string,
): string {
  const tenant = TENANTS[tenantId];

  return layout(
    "Member Lookup",
    `
<h2>Member Lookup</h2>
${message ? `<div class="notice">${escapeHtml(message)}</div>` : ""}
<form method="get" action="/t/${tenantId}/member">
  <label for="memberId">${escapeHtml(tenant.memberLabel)}</label>
  <input
    id="memberId"
    name="memberId"
    aria-label="${escapeHtml(tenant.memberLabel)}"
  >
  <button type="submit">${escapeHtml(tenant.searchLabel)}</button>
</form>
`,
  );
}

export type Member = {
  id: string;
  name: string;
  status: string;
  savingsBalance: string;
};

export function memberDetailPage(
  tenantId: TenantId,
  member: Member,
): string {
  const tenant = TENANTS[tenantId];

  return layout(
    "Member Detail",
    `
<h2>Member Detail</h2>

<table>
  <tr>
    <td>${escapeHtml(tenant.memberLabel)}</td>
    <td>${escapeHtml(member.id)}</td>
  </tr>
  <tr>
    <td>Member Name</td>
    <td>${escapeHtml(member.name)}</td>
  </tr>
  <tr>
    <td>Status</td>
    <td>${escapeHtml(member.status)}</td>
  </tr>
  <tr>
    <td>${escapeHtml(tenant.savingsLabel)}</td>
    <td>${escapeHtml(member.savingsBalance)}</td>
  </tr>
</table>

<p>
  <a href="/t/${tenantId}/member/${encodeURIComponent(member.id)}/subaccount">
    Open Sub-Account
  </a>
</p>
`,
  );
}

export function subAccountFormPage(
  tenantId: TenantId,
  member: Member,
  error?: string,
): string {
  return layout(
    "Open Sub-Account",
    `
<h2>Open Sub-Account for Member</h2>

<p>
  Member:
  <strong>${escapeHtml(member.id)}</strong>
  — ${escapeHtml(member.name)}
</p>

${error ? `<div class="error">${escapeHtml(error)}</div>` : ""}

<form
  method="post"
  action="/t/${tenantId}/member/${encodeURIComponent(member.id)}/subaccount/review"
>
  <div>
    <label for="accountType">Account Type</label>
    <select id="accountType" name="accountType">
      <option value="">-- Select --</option>
      <option value="checking">Checking</option>
      <option value="money-market">Money Market</option>
      <option value="certificate">Certificate</option>
    </select>
  </div>

  <div>
    <label for="initialDeposit">Initial Deposit</label>
    <input id="initialDeposit" name="initialDeposit">
  </div>

  <div>
    <label for="nickname">Nickname</label>
    <input id="nickname" name="nickname">
  </div>

  <button type="submit">Review</button>
</form>
`,
  );
}

export function subAccountReviewPage(
  tenantId: TenantId,
  member: Member,
  values: {
    accountType: string;
    initialDeposit: string;
    nickname: string;
  },
): string {
  return layout(
    "Review New Sub-Account",
    `
<h2>Review New Sub-Account</h2>

<table>
  <tr>
    <td>Member</td>
    <td>${escapeHtml(member.id)}</td>
  </tr>
  <tr>
    <td>Account Type</td>
    <td>${escapeHtml(values.accountType)}</td>
  </tr>
  <tr>
    <td>Initial Deposit</td>
    <td>${escapeHtml(values.initialDeposit)}</td>
  </tr>
  <tr>
    <td>Nickname</td>
    <td>${escapeHtml(values.nickname)}</td>
  </tr>
</table>

<form
  method="post"
  action="/t/${tenantId}/member/${encodeURIComponent(member.id)}/subaccount/confirm"
>
  <input
    type="hidden"
    name="accountType"
    value="${escapeHtml(values.accountType)}"
  >
  <input
    type="hidden"
    name="initialDeposit"
    value="${escapeHtml(values.initialDeposit)}"
  >
  <input
    type="hidden"
    name="nickname"
    value="${escapeHtml(values.nickname)}"
  >

  <button type="submit">Confirm &amp; Create</button>
</form>
`,
  );
}

export function messagePage(
  title: string,
  message: string,
  extra = "",
): string {
  return layout(
    title,
    `
<h2>${escapeHtml(title)}</h2>
<p>${escapeHtml(message)}</p>
${extra}
`,
  );
}

export function sessionInterstitial(
  continueUrl: string,
): string {
  return layout(
    "Session Idle",
    `
<h2>Session was idle</h2>
<p>Do you want to continue?</p>

<p>
  <a href="${escapeHtml(continueUrl)}">Continue</a>
</p>
`,
  );
}