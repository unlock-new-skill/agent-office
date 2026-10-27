import { useEffect, useRef } from 'react';
import type { ReactNode } from 'react';
import Phaser from 'phaser';

type Agent = { id: string; state: string; project: string };
export function PixelWorld({ agents, onSelect }: { agents: Agent[]; onSelect: (id: string) => void }): ReactNode {
  const host = useRef<HTMLDivElement>(null); const agentsRef = useRef(agents); agentsRef.current = agents;
  useEffect(() => {
    if (!host.current) return;
    class OfficeScene extends Phaser.Scene {
      create(): void { this.renderOffice(); }
      update(): void { this.renderOffice(); }
      private renderOffice(): void {
        this.children.removeAll(true); const width = this.scale.width; const height = this.scale.height;
        this.add.rectangle(width / 2, height / 2, width, height, 0x33575a); for (let x = 0; x < width; x += 32) this.add.line(0, 0, x, 0, x, height, 0xffffff, 0.06).setOrigin(0); for (let y = 0; y < height; y += 32) this.add.line(0, 0, 0, y, width, y, 0xffffff, 0.06).setOrigin(0);
        agentsRef.current.forEach((agent, index) => { const x = width * (0.18 + (index % 4) * 0.2); const y = height * (0.22 + Math.floor(index / 4) * 0.28); const color = agent.state === 'blocked' ? 0xd96f60 : agent.state === 'error' ? 0xd875ad : 0x638fa1; const avatar = this.add.rectangle(x, y, 28, 25, color).setStrokeStyle(3, 0x312b2c).setInteractive(); this.add.rectangle(x, y - 22, 20, 20, 0xe7b477).setStrokeStyle(3, 0x312b2c); this.add.text(x - 24, y + 20, agent.id, { color: '#f0e3d1', fontSize: '9px', backgroundColor: '#172023', padding: { x: 3, y: 3 } }); avatar.on('pointerdown', () => onSelect(agent.id)); });
      }
    }
    const game = new Phaser.Game({ type: Phaser.AUTO, width: '100%', height: 520, parent: host.current, backgroundColor: '#33575a', scene: OfficeScene, scale: { mode: Phaser.Scale.RESIZE, autoCenter: Phaser.Scale.CENTER_BOTH } });
    return () => game.destroy(true);
  }, [onSelect]);
  return <div className="pixel-stage" ref={host} aria-label="Pixel agent office" />;
}
