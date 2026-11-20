/**
 * Who am I and which table do I sit at?
 *
 * Inside Discord (the iframe URL carries `frame_id`) we run the Embedded App
 * SDK handshake. Anywhere else this is a no-op that invents a guest, so the
 * game runs in a plain browser tab and two tabs can play each other.
 * The SDK is imported dynamically so it costs nothing outside Discord.
 */
export interface Identity {
  name: string;
  /** players with the same instance share a room */
  instanceId: string;
  embedded: boolean;
}

const GUESTS = ["Earl", "Oolong", "Pekoe", "Assam", "Rooibos", "Sencha", "Keemun", "Yerba", "Biscuit", "Crumpet", "Scone", "Doily"];

export async function identify(): Promise<Identity> {
  const q = new URLSearchParams(location.search);
  if (!q.has("frame_id")) {
    let name = q.get("name") ?? "";
    if (!name) {
      try {
        name = sessionStorage.getItem("teapot.name") ?? "";
      } catch {
        /* storage can be blocked in iframes */
      }
    }
    if (!name) name = `${GUESTS[Math.floor(Math.random() * GUESTS.length)]} ${10 + Math.floor(Math.random() * 90)}`;
    try {
      sessionStorage.setItem("teapot.name", name);
    } catch {
      /* fine */
    }
    return { name, instanceId: q.get("room") ?? "local", embedded: false };
  }

  const fallback: Identity = { name: "Guest", instanceId: q.get("instance_id") ?? "discord", embedded: true };
  const clientId = import.meta.env.VITE_DISCORD_CLIENT_ID as string | undefined;
  if (!clientId) return fallback;
  try {
    const { DiscordSDK } = await import("@discord/embedded-app-sdk");
    const sdk = new DiscordSDK(clientId);
    await sdk.ready();
    fallback.instanceId = sdk.instanceId || fallback.instanceId;
    const { code } = await sdk.commands.authorize({
      client_id: clientId,
      response_type: "code",
      state: "",
      prompt: "none",
      scope: ["identify"],
    });
    // The exchange needs the client secret, so it happens on our server.
    const r = await fetch("/.proxy/api/token", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code }),
    });
    if (!r.ok) return fallback;
    const { access_token } = (await r.json()) as { access_token: string };
    const auth = await sdk.commands.authenticate({ access_token });
    const user = auth?.user as { global_name?: string | null; username?: string } | undefined;
    return { ...fallback, name: user?.global_name || user?.username || "Guest" };
  } catch (e) {
    console.warn("[teapot] Discord handshake failed; playing as a guest", e);
    return fallback;
  }
}
