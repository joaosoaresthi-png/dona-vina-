import admin from "firebase-admin";

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT))
  });
}

const MASTER_EMAIL = "joaosoaresthi@gmail.com";

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Método não permitido" });

  try {
    const authHeader = req.headers.authorization || "";
    const token = authHeader.replace("Bearer ", "");
    const decoded = await admin.auth().verifyIdToken(token);

    if ((decoded.email || "").toLowerCase() !== MASTER_EMAIL.toLowerCase()) {
      return res.status(403).json({ error: "Apenas o e-mail Master pode alterar senhas." });
    }

    const { targetEmail, newPassword } = req.body;
    if (!targetEmail || !newPassword || newPassword.length < 6) {
      return res.status(400).json({ error: "Informe o e-mail e uma senha com no mínimo 6 caracteres." });
    }

    const userRecord = await admin.auth().getUserByEmail(targetEmail);
    await admin.auth().updateUser(userRecord.uid, { password: newPassword });

    return res.status(200).json({ ok: true });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
