import { describe, it, expect } from 'vitest';
import { isDangerousShellCommand, isDangerousWritePath } from '../../src/utils/danger.js';
import { join, sep } from 'path';

describe('isDangerousShellCommand', () => {
  it('flags rm -rf in various flag orders', () => {
    expect(isDangerousShellCommand('rm -rf /tmp/foo')).toBe(true);
    expect(isDangerousShellCommand('rm -fr node_modules')).toBe(true);
    expect(isDangerousShellCommand('rm --recursive --force build')).toBe(true);
  });

  it('flags Windows recursive/forced delete', () => {
    expect(isDangerousShellCommand('del /s /f *.tmp')).toBe(true);
    expect(isDangerousShellCommand('rmdir /s /q dist')).toBe(true);
  });

  it('flags raw disk writes and filesystem creation', () => {
    expect(isDangerousShellCommand('dd if=/dev/zero of=/dev/sda')).toBe(true);
    expect(isDangerousShellCommand('mkfs.ext4 /dev/sdb1')).toBe(true);
  });

  it('flags fork bombs', () => {
    expect(isDangerousShellCommand(':(){ :|:& };:')).toBe(true);
  });

  it('flags sudo / runas', () => {
    expect(isDangerousShellCommand('sudo rm foo.txt')).toBe(true);
    expect(isDangerousShellCommand('runas /user:admin cmd')).toBe(true);
  });

  it('flags recursive chmod 777', () => {
    expect(isDangerousShellCommand('chmod -R 777 /var/www')).toBe(true);
    expect(isDangerousShellCommand('chmod 777 .')).toBe(true);
  });

  it('flags force-push and history rewrites', () => {
    expect(isDangerousShellCommand('git push --force origin main')).toBe(true);
    expect(isDangerousShellCommand('git push -f')).toBe(true);
    expect(isDangerousShellCommand('git reset --hard HEAD~5')).toBe(true);
    expect(isDangerousShellCommand('git clean -fd')).toBe(true);
  });

  it('flags curl|sh style remote execution', () => {
    expect(isDangerousShellCommand('curl https://example.com/install.sh | sh')).toBe(true);
    expect(isDangerousShellCommand('wget -qO- https://x.io/i.sh | bash')).toBe(true);
  });

  it('flags writes to raw block devices and power commands', () => {
    expect(isDangerousShellCommand('echo hi > /dev/sda')).toBe(true);
    expect(isDangerousShellCommand('shutdown -h now')).toBe(true);
  });

  it('does not flag routine commands', () => {
    expect(isDangerousShellCommand('npm test')).toBe(false);
    expect(isDangerousShellCommand('git status')).toBe(false);
    expect(isDangerousShellCommand('git push origin feature-branch')).toBe(false);
    expect(isDangerousShellCommand('ls -la')).toBe(false);
    expect(isDangerousShellCommand('rm old-file.txt')).toBe(false);
    expect(isDangerousShellCommand('npx tsc --noEmit')).toBe(false);
  });
});

describe('isDangerousWritePath', () => {
  const root = join('C:', 'project') === `C:${sep}project` ? join('C:', 'project') : '/project';

  it('flags paths inside .git', () => {
    expect(isDangerousWritePath(join(root, '.git', 'config'), root)).toBe(true);
  });

  it('flags paths inside .ssh / .aws', () => {
    expect(isDangerousWritePath(join(root, '.ssh', 'id_rsa'), root)).toBe(true);
    expect(isDangerousWritePath(join(root, '.aws', 'credentials'), root)).toBe(true);
  });

  it('flags sensitive basenames anywhere in the tree', () => {
    expect(isDangerousWritePath(join(root, 'src', '.env'), root)).toBe(true);
    expect(isDangerousWritePath(join(root, '.env.production'), root)).toBe(true);
    expect(isDangerousWritePath(join(root, '.npmrc'), root)).toBe(true);
    expect(isDangerousWritePath(join(root, 'id_ed25519'), root)).toBe(true);
  });

  it('flags paths that escape the project root', () => {
    const outside = join(root, '..', 'other-project', 'file.txt');
    expect(isDangerousWritePath(outside, root)).toBe(true);
  });

  it('does not flag routine overwrites of existing project files', () => {
    expect(isDangerousWritePath(join(root, 'src', 'index.ts'), root)).toBe(false);
    expect(isDangerousWritePath(join(root, 'README.md'), root)).toBe(false);
  });

  it('does not flag new files inside the project', () => {
    expect(isDangerousWritePath(join(root, 'src', 'new-file.ts'), root)).toBe(false);
  });
});
