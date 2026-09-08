import { WorkspaceShell } from "@/components/workspace-shell";
import { BrandEditor } from "@/features/brands/brand-editor";

export default function BrandKitsPage() {
  return <WorkspaceShell current="workspace" title="Brand Kits"><section><h1>Brand Kits</h1><p>Store the identity a carousel is signed with. Applying a kit copies its values into that project.</p><BrandEditor /></section></WorkspaceShell>;
}
