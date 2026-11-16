import {
  Check,
  Field,
  type FormController,
} from "../../ui/board/primitives.tsx";
import type {
  BoardEvent,
  FinanceCommand,
  FinancePreview,
  ModalProps,
  OpenModal,
} from "../../ui/board/types.ts";
import type { SelectionSnapshot } from "../../ui/music/selection-store.ts";

// Compile-only regression checks: these contracts must reject unsafe callers.
function checkContracts(
  event: BoardEvent,
  open: OpenModal,
  form: FormController<{ name: string; enabled: boolean }>,
  preview: FinancePreview,
  selection: SelectionSnapshot,
) {
  open("attendee", { event, personId: "person" });
  open("account");
  form.set("enabled", true);
  Field({ form, name: "name", label: "称呼" });
  Check({ form, name: "enabled", label: "开启" });
  // @ts-expect-error A text field cannot write into a boolean value.
  Field({ form, name: "enabled", label: "开启" });
  // @ts-expect-error A checkbox cannot write into a string value.
  Check({ form, name: "name", label: "称呼" });
  // @ts-expect-error An attendee dialog must identify the attendee.
  open("attendee", { event });
  // @ts-expect-error A poll dialog uses pollId rather than eventId.
  open("poll", { eventId: event.id });
  // @ts-expect-error Form keys are checked.
  form.set("missing", "value");
  // @ts-expect-error Boolean controls cannot receive arbitrary strings.
  form.set("enabled", "true");
  const command: FinanceCommand = {
    command: "record",
    base_revision: 1,
    // @ts-expect-error Server amounts and editable currency strings are different.
    transaction: preview.command.transaction,
  };
  // @ts-expect-error Familiarity levels are numeric, not display labels.
  const level: SelectionSnapshot["levels"][string] = "常听";
  return { command, level, selection };
}
void checkContracts;
const props: ModalProps["detail"] = { eventId: "event" };
void props;
