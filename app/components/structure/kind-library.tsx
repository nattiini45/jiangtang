import { useEffect, useRef, useState } from "react";
import { useFetcher } from "react-router";
import type { action, loader } from "~/routes/_desktop.admin.structure/route";
import { useLocale, useT } from "~/i18n/use-t";
import { Button } from "~/components/ui/button";
import { Select } from "~/components/ui/select";
import { Checkbox } from "~/components/ui/checkbox";

type Library = Awaited<ReturnType<typeof loader>>["library"];
export function KindLibrary({ library }: { library: Library }) {
  const t = useT();
  const locale = useLocale();
  const dialog = useRef<HTMLDialogElement>(null);
  const fetcher = useFetcher<typeof action>();
  const [institution, setInstitution] = useState("");
  const [selected, setSelected] = useState<string[]>([]);
  const kinds = library.kinds.filter((kind) => kind.institution_types.includes(institution));
  const available = (kind: Library["kinds"][number]) =>
    kind.status === "available" && !kind.groupArchived;
  const chosen = selected.filter((key) =>
    kinds.some((kind) => kind.key === key && available(kind)),
  );
  const busy = fetcher.state !== "idle";
  useEffect(() => {
    if (!busy && fetcher.data?.changed) dialog.current?.close();
  }, [busy, fetcher.data]);
  return (
    <>
      <Button
        type="button"
        variant="secondary"
        onClick={() => {
          fetcher.reset();
          setInstitution("");
          setSelected([]);
          dialog.current?.showModal();
        }}
      >
        {t("admin.structure.library.add")}
      </Button>
      <dialog
        ref={dialog}
        onCancel={(event) => {
          if (busy) event.preventDefault();
        }}
        aria-labelledby="kind-library-title"
        className="bg-card text-foreground shadow-surface-5 fixed inset-0 m-auto max-h-[calc(100dvh-3rem)] w-[min(48rem,calc(100%-3rem))] overflow-y-auto rounded-xl p-6 backdrop:bg-(--scrim)"
      >
        <fetcher.Form method="post" className="flex flex-col gap-4">
          <h2 id="kind-library-title" className="text-lg font-semibold">
            {t("admin.structure.library.add")}
          </h2>
          <p className="text-muted-foreground text-sm">{t("admin.structure.library.help")}</p>
          <input type="hidden" name="intent" value="install" />
          <label className="text-sm">
            {t("admin.structure.library.institution")}
            <Select
              aria-label={t("admin.structure.library.institution")}
              value={institution}
              onChange={(event) => {
                const value = event.target.value;
                setInstitution(value);
                setSelected(
                  library.kinds
                    .filter(
                      (kind) =>
                        kind.institution_types.includes(value) &&
                        kind.tier === "core" &&
                        available(kind),
                    )
                    .map((kind) => kind.key),
                );
              }}
            >
              <option value="">{t("admin.structure.library.chooseInstitution")}</option>
              {library.institutionTypes.map((type) => (
                <option key={type.key} value={type.key}>
                  {type[locale]}
                </option>
              ))}
            </Select>
          </label>
          <p className="text-muted-foreground nums text-sm">
            {t("admin.structure.library.remaining", { count: library.remaining })}{" "}
            {t("admin.structure.library.language", {
              language: t(
                library.installationLocale === "de"
                  ? "admin.structure.library.german"
                  : "admin.structure.library.english",
              ),
            })}
          </p>
          {institution ? (
            <div className="flex flex-col gap-4">
              {library.functionGroups.map((group) => {
                const entries = kinds.filter((kind) => kind.group === group.key);
                if (!entries.length) return null;
                return (
                  <fieldset key={group.key}>
                    <legend className="mb-1 text-sm font-semibold">{group[locale]}</legend>
                    <div className="divide-border divide-y">
                      {entries.map((kind) => (
                        <label
                          key={kind.key}
                          className="hover:bg-hover flex min-h-control cursor-pointer items-center gap-3 py-row"
                        >
                          <Checkbox
                            name="keys"
                            value={kind.key}
                            checked={chosen.includes(kind.key)}
                            disabled={busy || !available(kind)}
                            onChange={(event) =>
                              setSelected((current) =>
                                event.target.checked
                                  ? [...current, kind.key]
                                  : current.filter((key) => key !== kind.key),
                              )
                            }
                          />
                          <span className="min-w-0 flex-1">
                            <span className="block truncate text-sm" title={kind[locale]}>
                              {kind[locale]}
                            </span>
                            {kind.installedName ? (
                              <span
                                className="text-muted-foreground block truncate text-xs"
                                title={kind.installedName}
                              >
                                {t("admin.structure.library.installedAs", {
                                  name: kind.installedName,
                                })}
                              </span>
                            ) : locale !== library.installationLocale ? (
                              <span
                                className="text-muted-foreground block truncate text-xs"
                                title={kind.installationName}
                              >
                                {t("admin.structure.library.willInstallAs", {
                                  name: kind.installationName,
                                })}
                              </span>
                            ) : null}
                          </span>
                          <span className="text-muted-foreground text-xs">
                            {t(
                              kind.tier === "core"
                                ? "admin.structure.library.core"
                                : kind.tier === "common"
                                  ? "admin.structure.library.common"
                                  : "admin.structure.library.special",
                            )}
                          </span>
                          {kind.status !== "available" || kind.groupArchived ? (
                            <span className="text-muted-foreground w-28 text-right text-xs">
                              {t(
                                kind.groupArchived && kind.status === "available"
                                  ? "admin.structure.library.groupArchived"
                                  : kind.status === "present"
                                    ? "admin.structure.library.present"
                                    : kind.status === "archived"
                                      ? "admin.structure.archived"
                                      : "admin.structure.library.taken",
                              )}
                            </span>
                          ) : null}
                        </label>
                      ))}
                    </div>
                  </fieldset>
                );
              })}
            </div>
          ) : null}
          {fetcher.data && !fetcher.data.changed ? (
            <p role="alert" className="text-destructive text-sm">
              {[...Object.values(fetcher.data.fieldErrors).flat(), ...fetcher.data.formErrors].join(
                " ",
              )}
            </p>
          ) : null}
          <footer className="bg-card sticky -bottom-6 -mx-6 -mb-6 flex items-center justify-end gap-2 px-6 py-4">
            <Button
              type="button"
              variant="ghost"
              onClick={() => dialog.current?.close()}
              disabled={busy}
            >
              {t("common.cancel")}
            </Button>
            <Button disabled={busy || !chosen.length || chosen.length > library.remaining}>
              {t(
                chosen.length === 1
                  ? "admin.structure.library.installOne"
                  : "admin.structure.library.install",
                { count: chosen.length },
              )}
            </Button>
          </footer>
        </fetcher.Form>
      </dialog>
    </>
  );
}
