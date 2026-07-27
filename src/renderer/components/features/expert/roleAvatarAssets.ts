import lanxiAvatar from '../../../assets/roles/lanxi.webp';
import mingjingAvatar from '../../../assets/roles/mingjing.webp';
import muzhiAvatar from '../../../assets/roles/muzhi.webp';
import qingheAvatar from '../../../assets/roles/qinghe.webp';
import suzhenAvatar from '../../../assets/roles/suzhen.webp';
import yanjiuyuanAvatar from '../../../assets/roles/yanjiuyuan.webp';
import yingchuanAvatar from '../../../assets/roles/yingchuan.webp';
import zhiweiAvatar from '../../../assets/roles/zhiwei.webp';

const ROLE_AVATAR_ASSETS: Readonly<Record<string, string>> = {
  数据分析师: zhiweiAvatar,
  牧之: muzhiAvatar,
  溯真: suzhenAvatar,
  青禾: qingheAvatar,
  明镜: mingjingAvatar,
  岚析: lanxiAvatar,
  映川: yingchuanAvatar,
  研究员: yanjiuyuanAvatar,
};

export function getRoleAvatarAsset(roleId: string): string | undefined {
  return ROLE_AVATAR_ASSETS[roleId];
}
