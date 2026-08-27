import http from "node:http";

const PORT = Number(process.env.MOCK_PORT ?? 7799);

type Tenant = "cu-a" | "cu-b";

type Member = {
  id: string;
  name: string;
  savingsBalance: string;
};

const MEMBERS: Record<string, Member> = {
  "12345": {
    id: "12345",
    name: "Jamie Smith",
    savingsBalance: "$4,210.55",
  },
  "00000": {
    id: "00000",
    name: "Interstitial Demo",
    savingsBalance: "$100.00",
  },
};

function esc(s: unknown): string {
  return String(s ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function shell(title: string, body: string): string {
  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <title>${esc(title)}</title>
  <style>
    body {
      font-family: Arial, sans-serif;
      margin: 32px;
      color: #222;
    }

    .panel {
      max-width: 760px;
      border: 1px solid #bbb;
      padding: 24px;
    }

    table {
      border-collapse: collapse;
      margin-top: 16px;
    }

    td, th {
      border: 1px solid #bbb;
      padding: 8px 12px;
      text-align: left;
    }

    label {
      display: block;
      margin: 12px 0;
    }

    input, select {
      margin-left: 8px;
    }

    .error {
      color: #a00;
      font-weight: bold;
    }

    .muted {
      color: #666;
    }
  </style>
</head>
<body>
  <div class="panel">
    ${body}
  </div>
</body>
</html>`;
}

function signIn(tenant: Tenant): string {
  return shell(
    "Operator Sign In",
    `
    <h1>Operator Sign In</h1>

    <form method="POST" action="/t/${tenant}/signin">
      <label>
        Operator ID
        <input name="op" autocomplete="off">
      </label>

      <label>
        Password
        <input name="pw" type="password">
      </label>

      <button type="submit">Sign In</button>
    </form>
  `,
  );
}

function memberLookup(
  tenant: Tenant,
  message = "",
): string {
  const memberLabel =
    tenant === "cu-b" ? "Member Number" : "Member ID";

  const searchLabel =
    tenant === "cu-b" ? "Find Member" : "Search";

  return shell(
    "Member Lookup",
    `
    <h1>Member Lookup</h1>

    ${message ? `<p class="error">${esc(message)}</p>` : ""}

    <form method="GET" action="/t/${tenant}/member">
      <label>
        ${memberLabel}
        <input
          name="memberId"
          aria-label="${memberLabel}"
          autocomplete="off"
        >
      </label>

      <button type="submit">${searchLabel}</button>
    </form>
  `,
  );
}

function memberDetail(
  tenant: Tenant,
  member: Member,
): string {
  const balanceLabel =
    tenant === "cu-b" ? "Savings Bal." : "Savings Balance";

  return shell(
    "Member Detail",
    `
    <h1>Member Detail</h1>

    <table>
      <tr>
        <th>Member ID</th>
        <td>${esc(member.id)}</td>
      </tr>

      <tr>
        <th>Name</th>
        <td>${esc(member.name)}</td>
      </tr>

      <tr>
        <th>Status</th>
        <td>Active</td>
      </tr>

      <tr>
        <th>${balanceLabel}</th>
        <td>${esc(member.savingsBalance)}</td>
      </tr>
    </table>

    <p>
      <a href="/t/${tenant}/member/${encodeURIComponent(member.id)}/subaccount">
        Open Sub-Account
      </a>
    </p>
  `,
  );
}

function idleInterstitial(
  tenant: Tenant,
  memberId: string,
): string {
  return shell(
    "Session Interstitial",
    `
    <h1>Your session was idle. Do you want to continue?</h1>

    <p>
      <a href="/t/${tenant}/member?id=${encodeURIComponent(memberId)}&continued=1">
        Continue
      </a>
    </p>
  `,
  );
}

function subAccountForm(
  tenant: Tenant,
  memberId: string,
  error = "",
): string {
  return shell(
    `Open Sub-Account for Member #${memberId}`,
    `
    <h1>Open Sub-Account for Member #${esc(memberId)}</h1>

    ${error ? `<p class="error">${esc(error)}</p>` : ""}

    <form method="POST"
          action="/t/${tenant}/member/${encodeURIComponent(memberId)}/subaccount/review">

      <label>
        Account Type
        <select name="accountType" aria-label="Account Type">
          <option value="">Choose...</option>
          <option value="savings">Savings</option>
          <option value="money_market">Money Market</option>
          <option value="cd">CD</option>
        </select>
      </label>

      <label>
        Initial Deposit
        <input
          name="initialDeposit"
          aria-label="Initial Deposit"
        >
      </label>

      <label>
        Nickname
        <input
          name="nickname"
          aria-label="Nickname"
        >
      </label>

      <button type="submit">Review</button>
    </form>
  `,
  );
}

function reviewSubAccount(
  tenant: Tenant,
  memberId: string,
  accountType: string,
  initialDeposit: string,
  nickname: string,
): string {
  return shell(
    "Review New Sub-Account",
    `
    <h1>Review New Sub-Account</h1>

    <table>
      <tr>
        <th>Member ID</th>
        <td>${esc(memberId)}</td>
      </tr>
      <tr>
        <th>Account Type</th>
        <td>${esc(accountType)}</td>
      </tr>
      <tr>
        <th>Initial Deposit</th>
        <td>${esc(initialDeposit)}</td>
      </tr>
      <tr>
        <th>Nickname</th>
        <td>${esc(nickname)}</td>
      </tr>
      <tr>
        <th>Confirmation Ref</th>
        <td>SA-4821</td>
      </tr>
    </table>

    <p class="muted">
      Review only — this mock intentionally stops before the irreversible final create.
    </p>
  `,
  );
}

function parseBody(
  req: http.IncomingMessage,
): Promise<Record<string, string>> {
  return new Promise((resolve) => {
    let raw = "";

    req.on("data", (chunk) => {
      raw += String(chunk);
    });

    req.on("end", () => {
      const out: Record<string, string> = {};
      const params = new URLSearchParams(raw);

      for (const [key, value] of params.entries()) {
        out[key] = value;
      }

      resolve(out);
    });
  });
}

function tenantFromPath(pathname: string): Tenant {
  return pathname.startsWith("/t/cu-b/")
    ? "cu-b"
    : "cu-a";
}

const server = http.createServer(
  async (req, res) => {
    const url = new URL(
      req.url ?? "/",
      `http://localhost:${PORT}`,
    );

    const tenant = tenantFromPath(url.pathname);

    const html = (value: string, status = 200): void => {
      res.writeHead(status, {
        "content-type": "text/html; charset=utf-8",
      });

      res.end(value);
    };

    const redirect = (location: string): void => {
      res.writeHead(302, { location });
      res.end();
    };

    if (
      url.pathname === "/" ||
      url.pathname === "/t/cu-a/" ||
      url.pathname === "/t/cu-b/"
    ) {
      html(signIn(tenant));
      return;
    }

    if (
      req.method === "POST" &&
      url.pathname === `/t/${tenant}/signin`
    ) {
      const body = await parseBody(req);

      if (!body.op || !body.pw) {
        html(signIn(tenant), 400);
        return;
      }

      redirect(`/t/${tenant}/lookup`);
      return;
    }

    if (url.pathname === `/t/${tenant}/lookup`) {
      html(memberLookup(tenant));
      return;
    }

    if (url.pathname === `/t/${tenant}/member`) {
      const memberId =
        url.searchParams.get("id") ??
        url.searchParams.get("memberId") ??
        "";

      if (memberId === "99999") {
        html(
          memberLookup(
            tenant,
            "No member found for ID 99999.",
          ),
        );
        return;
      }

      if (memberId === "00000") {
        if (url.searchParams.get("continued") !== "1") {
          html(idleInterstitial(tenant, memberId));
          return;
        }

        html(memberDetail(tenant, MEMBERS["00000"]!));
        return;
      }

      if (memberId === "50000") {
        html(
          shell(
            "System Error",
            `
            <h1>Unexpected error (HTTP 500).</h1>
            <p>Backend system error.</p>
          `,
          ),
          500,
        );
        return;
      }

      if (memberId === "40300") {
        html(
          shell(
            "Access Denied",
            `
            <h1>Not authorized to view this member.</h1>
          `,
          ),
          403,
        );
        return;
      }

      const member = MEMBERS[memberId];

      if (!member) {
        html(
          memberLookup(
            tenant,
            `No member found for ID ${memberId}.`,
          ),
        );
        return;
      }

      html(memberDetail(tenant, member));
      return;
    }

    const subaccountMatch = url.pathname.match(
      /^\/t\/(cu-a|cu-b)\/member\/([^/]+)\/subaccount$/,
    );

    if (
      req.method === "GET" &&
      subaccountMatch
    ) {
      const memberId =
        decodeURIComponent(subaccountMatch[2] ?? "");

      html(subAccountForm(tenant, memberId));
      return;
    }

    const reviewMatch = url.pathname.match(
      /^\/t\/(cu-a|cu-b)\/member\/([^/]+)\/subaccount\/review$/,
    );

    if (
      req.method === "POST" &&
      reviewMatch
    ) {
      const memberId =
        decodeURIComponent(reviewMatch[2] ?? "");

      const body = await parseBody(req);

      const accountType = body.accountType ?? "";
      const initialDeposit = body.initialDeposit ?? "";
      const nickname = body.nickname ?? "";

      const amount = Number(initialDeposit);

      if (
        !accountType ||
        !initialDeposit ||
        !Number.isFinite(amount) ||
        amount <= 0
      ) {
        html(
          subAccountForm(
            tenant,
            memberId,
            "Initial deposit must be a positive dollar amount and account type is required.",
          ),
        );
        return;
      }

      html(
        reviewSubAccount(
          tenant,
          memberId,
          accountType,
          initialDeposit,
          nickname,
        ),
      );
      return;
    }

    html(
      shell(
        "Not Found",
        "<h1>404 Not Found</h1>",
      ),
      404,
    );
  },
);

server.listen(PORT, () => {
  console.log(
    `mock servicing console listening on http://localhost:${PORT}`,
  );
});