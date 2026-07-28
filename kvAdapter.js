export class D1AsKV {
  constructor(db, oldKv = null) {
    this.db = db;
    this.oldKv = oldKv;
  }

  async get(key, options = "text") {
    const format = typeof options === "object" && options !== null 
      ? options.type 
      : options;

    const row = await this.db
      .prepare("SELECT value FROM kv_store WHERE key = ?")
      .bind(key)
      .first();

    if (row && row.value !== null) {
      return format === "json" ? JSON.parse(row.value) : row.value;
    }

    if (this.oldKv) {
      const val = await this.oldKv.get(key, options);
      if (val !== null) {
        await this.put(key, val);
        return val;
      }
    }

    return null;
  }

  async put(key, value) {
    const valStr = typeof value === "object" ? JSON.stringify(value) : String(value);

    await this.db
      .prepare(
        `INSERT INTO kv_store (key, value) 
         VALUES (?, ?) 
         ON CONFLICT(key) DO UPDATE SET value=excluded.value`
      )
      .bind(key, valStr)
      .run();
  }

  async delete(key) {
    await this.db.prepare("DELETE FROM kv_store WHERE key = ?").bind(key).run();
    if (this.oldKv) {
      await this.oldKv.delete(key).catch(() => {});
    }
  }
}