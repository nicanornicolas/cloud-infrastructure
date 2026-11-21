// ORIGINAL endpoint exactly as supplied in the brief. Reference only — DO NOT DEPLOY.
app.post("/v1/partners/:partner/parcels", async (req, res) => {
  const { ref, lockerId, size } = req.body;
  const locker = await db.collection("lockers").doc(lockerId).get();
  if (locker.data().status !== "online") {
    return res.status(200).json({ ok: false, error: "locker offline" });
  }
  const id = await createParcel(req.params.partner, ref, lockerId, size);
  res.json({ id });
});
