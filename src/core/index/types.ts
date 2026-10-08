export interface CodeSymbol {
  name: string;
  kind: 'function' | 'class' | 'interface' | 'type' | 'export' | 'const' | 'variable';
  file: string;
  line: number;
}
