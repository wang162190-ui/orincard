import { getTranslations } from "next-intl/server";
import { WorkspacePage } from "@/components/workspace-page";
import { templateCards } from "@/features/templates/catalog";
import { TemplateGallery } from "@/features/templates/template-gallery";

export default async function TemplatesPage() {
  const t = await getTranslations("Templates");
  return (
    <WorkspacePage title={t("shellTitle")}>
      <div className="stack-lg">
        <header>
          <p className="eyebrow">{t("eyebrow")}</p>
          <h1>{t("heading")}</h1>
          <p className="lead">{t("lead")}</p>
        </header>
        <TemplateGallery templates={templateCards} />
      </div>
    </WorkspacePage>
  );
}
