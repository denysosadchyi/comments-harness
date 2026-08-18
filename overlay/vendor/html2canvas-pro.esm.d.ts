/* Рукописний шим типів на вендорений `html2canvas-pro.esm.js`.

   Чому не покладені поруч оригінальні `dist/types/*`: вони — дерево з
   двох десятків файлів, що описує весь внутрішній CSS-парсер бібліотеки, а
   викликається звідси рівно одна функція з жменею опцій. Тягнути дерево
   заради цього означає, що `tsc -b` щоразу читає чужі типи, а `npm install`
   і `.gitignore` мають про них знати. Описано те, що реально вживається:
   зайва опція краще впаде тут, ніж мовчки поїде в рантайм. */
export interface Html2CanvasOptions {
  /* Прямокутник вирізки — у координатах ДОКУМЕНТА (тобто з урахуванням
     прокрутки), а не в'юпорта. */
  x?: number
  y?: number
  width?: number
  height?: number
  /* Множник щільності пікселів кінцевого канваса. */
  scale?: number
  /* `null` дає прозоре тло; рядок — будь-який валідний CSS-колір. */
  backgroundColor?: string | null
  logging?: boolean
  useCORS?: boolean
  allowTaint?: boolean
  imageTimeout?: number
  removeContainer?: boolean
  /* Викликається на КОЖЕН вузол; `true` — вузол не потрапляє в клон. */
  ignoreElements?: (element: Element) => boolean
}

export default function html2canvas(
  element: HTMLElement,
  options?: Html2CanvasOptions,
): Promise<HTMLCanvasElement>
