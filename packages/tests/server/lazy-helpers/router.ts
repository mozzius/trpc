import { t } from '../router.test';

export default t.router({
  bar: t.procedure.query(() => 'zzz' as const),
});
