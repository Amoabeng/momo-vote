const express = require("express");
const bodyParser = require("body-parser");
const axios = require("axios");
const session = require("express-session");
const sqlite3 = require("sqlite3").verbose();
const { v4: uuidv4 } = require("uuid");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 3000;

// ---------- MIDDLEWARE ----------
app.use(bodyParser.urlencoded({ extended: true }));
app.use(bodyParser.json());

// Serve static files (VERY IMPORTANT for CSS & HTML)
app.use(express.static("public"));

app.use(session({
  secret: "very_secret_key",
  resave: false,
  saveUninitialized: false
}));

// ---------- DATABASE ----------
const db = new sqlite3.Database("./votes.db");

db.serialize(() => {
  db.run(`
    CREATE TABLE IF NOT EXISTS admins (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT,
      password TEXT
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS candidates (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT,
      votes INTEGER DEFAULT 0
    )
  `);

  // Insert admin if not exists
  db.get("SELECT COUNT(*) AS count FROM admins", (err, row) => {
    if (row.count === 0) {
      db.run(
        "INSERT INTO admins (username, password) VALUES (?, ?)",
        ["admin", "admin123"]
      );
    }
  });

  // Insert candidates if empty
  db.get("SELECT COUNT(*) AS count FROM candidates", (err, row) => {
    if (row.count === 0) {
      const candidates = ["John Mensah", "Grace Owusu", "Kwame Boateng"];
      candidates.forEach(name => {
        db.run("INSERT INTO candidates (name) VALUES (?)", [name]);
      });
    }
  });
});

// ---------- MTN MOMO ----------
const SUBSCRIPTION_KEY = "PUT_PRIMARY_KEY_HERE";
const TARGET_ENV = "sandbox";
let pendingPayments = {};

// ---------- AUTH ----------
function requireAdmin(req, res, next) {
  if (req.session.admin) next();
  else res.redirect("/admin-login");
}

// ---------- HOME PAGE ----------
app.get("/", (req, res) => {
  db.all("SELECT * FROM candidates", (err, rows) => {

    let html = `
    <link rel="stylesheet" href="/css/style.css">
    <div class="container">
      <h1>🗳️ Online Voting System</h1>
      <p style="text-align:center;">Secure voting powered by MoMo</p>
    `;

    rows.forEach(c => {
      html += `
        <div class="candidate">
          <h3>${c.name}</h3>
          <p>Votes: ${c.votes}</p>
          <form method="POST" action="/vote">
            <input type="hidden" name="candidateId" value="${c.id}">
            <input name="phone" placeholder="024XXXXXXX" required>
            <button type="submit">Pay & Vote</button>
          </form>
        </div>
      `;
    });

    html += `</div>`;

    res.send(html);
  });
});

// ---------- VOTE ----------
app.post("/vote", async (req, res) => {
  const candidateId = req.body.candidateId;
  const phone = req.body.phone;
  const referenceId = uuidv4();

  pendingPayments[referenceId] = candidateId;

  try {
    await axios.post(
      "https://sandbox.momodeveloper.mtn.com/collection/v1_0/requesttopay",
      {
        amount: "1",
        currency: "EUR",
        externalId: referenceId,
        payer: { partyIdType: "MSISDN", partyId: phone },
        payerMessage: "Vote payment",
        payeeNote: "Voting"
      },
      {
        headers: {
          "X-Reference-Id": referenceId,
          "X-Target-Environment": TARGET_ENV,
          "Ocp-Apim-Subscription-Key": SUBSCRIPTION_KEY,
          "Content-Type": "application/json"
        }
      }
    );

    res.send(`
      <div style="text-align:center; padding:50px;">
        <h2>💳 Payment Initiated</h2>
        <p>Dial on your phone to approve payment</p>
        <a href="/confirm/${referenceId}">Confirm Payment</a>
      </div>
    `);

  } catch {
    res.send("❌ Payment request failed");
  }
});

// ---------- CONFIRM ----------
app.get("/confirm/:ref", async (req, res) => {
  const ref = req.params.ref;
  const candidateId = pendingPayments[ref];

  if (!candidateId) return res.send("Invalid payment");

  try {
    const response = await axios.get(
      `https://sandbox.momodeveloper.mtn.com/collection/v1_0/requesttopay/${ref}`,
      {
        headers: {
          "X-Target-Environment": TARGET_ENV,
          "Ocp-Apim-Subscription-Key": SUBSCRIPTION_KEY
        }
      }
    );

    if (response.data.status === "SUCCESSFUL") {
      db.run(
        "UPDATE candidates SET votes = votes + 1 WHERE id = ?",
        [candidateId]
      );

      delete pendingPayments[ref];

      res.send(`
        <div style="text-align:center; padding:50px;">
          <h2>✅ Vote Successful!</h2>
          <p>Your vote has been recorded.</p>
          <a href="/">Go Back</a>
        </div>
      `);
    } else {
      res.send("⏳ Payment still pending...");
    }

  } catch {
    res.send("Error confirming payment");
  }
});

// ---------- ADMIN LOGIN ----------
app.get("/admin-login", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "admin-login.html"));
});

app.post("/admin-login", (req, res) => {
  const { username, password } = req.body;

  db.get(
    "SELECT * FROM admins WHERE username=? AND password=?",
    [username, password],
    (err, row) => {
      if (row) {
        req.session.admin = true;
        res.redirect("/admin");
      } else {
        res.send("❌ Login failed");
      }
    }
  );
});

// ---------- ADMIN PANEL ----------
app.get("/admin", requireAdmin, (req, res) => {
  res.sendFile(path.join(__dirname, "public", "admin.html"));
});

// ---------- API ----------
app.get("/api/candidates", (req, res) => {
  db.all("SELECT * FROM candidates", [], (err, rows) => {
    if (err) {
      res.status(500).json({ error: "Database error" });
    } else {
      res.json(rows);
    }
  });
});

// ---------- LOGOUT ----------
app.get("/logout", (req, res) => {
  req.session.destroy(() => res.redirect("/admin-login"));
});

// ---------- START ----------
app.listen(PORT, "0.0.0.0", () => {
  console.log(`Server running on port ${PORT}`);
});
