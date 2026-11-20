import * as Phaser from "phaser";
import { Sfx } from "./audio";
import { identify } from "./discord";
import { Net } from "./net";
import { GameScene } from "./scene";
import "./style.css";
import { Ui } from "./ui";

async function boot(): Promise<void> {
  const ui = new Ui();
  const sfx = new Sfx();
  const net = new Net();
  const scene = new GameScene(net, ui, sfx);
  // Audio may only start after a gesture; any first click or key will do.
  for (const ev of ["pointerdown", "keydown"]) window.addEventListener(ev, () => sfx.unlock(), { passive: true });

  const game = new Phaser.Game({
    type: Phaser.AUTO,
    parent: "game",
    backgroundColor: "#fde7c7",
    // RESIZE: the canvas always matches the iframe, from a small Discord
    // panel to fullscreen; the scene's camera does the fitting.
    scale: { mode: Phaser.Scale.RESIZE, width: "100%", height: "100%" },
    render: { antialias: true, powerPreference: "high-performance" },
    banner: false,
    audio: { noAudio: true },
    scene: [scene],
  });
  (window as any).__game = { game, scene, net };

  const id = await identify();
  await net.connect(id);
}

void boot();
